//! The notification groups, and turning a stored channel into something that can send.
//!
//! Small on purpose for now: routing decides *which* channels a notification reaches (that lives in
//! `lyra_db::channels`), and this decides how to talk to one of them. The producers that will call
//! into here — the alert sweep, the digest, a cron — still send the way they always did; wiring them
//! through routing is the next step, and doing it before the channels can be configured would have
//! meant routing to nothing.

use lyra_alerts::channels::Transport;
use lyra_db::channels::{ChannelStore, Severity};

use crate::jobs::deliver::Markup;
use lyra_alerts::config::ProcessEnv;
use lyra_alerts::discord::{DiscordSender, Webhook};
use lyra_alerts::telegram::{MessageSender, TelegramSender};

/// The groups a notification can belong to.
///
/// Three, from the shape of what Lyra actually sends. More would be a taxonomy nobody keeps
/// consistent; fewer would put the daily brief and a liquidation warning in one bucket, which is
/// exactly the distinction the feature exists to make.
///
/// - `money` — positions and balances. Time-sensitive, and about real money.
/// - `day` — the brief, habits, anything scheduled and expected. The only group where quiet hours
///   are the point.
/// - `system` — dead-lettered jobs, deploys, restarts. About the box rather than about you.
pub const GROUPS: [&str; 3] = ["money", "day", "system"];

/// Build something that can send through one channel.
///
/// `secret` is the unsealed credential when the transport stores one, and ignored when it does not —
/// Telegram reads its token from the environment, because a bot token is a stronger credential than
/// a room webhook and there is only one of it.
///
/// The error is a sentence for a person: this is reached from the test endpoint, where the reader is
/// looking at a form and wants to know what to change.
pub fn sender_for(
    transport: Transport,
    secret: Option<&str>,
) -> Result<Box<dyn MessageSender>, String> {
    match transport {
        Transport::Discord => {
            let url = secret.ok_or("this channel has no stored webhook URL")?;
            // The same check the write path ran, run again here rather than trusted. A row can be
            // older than the current rules — a host that was once allowed, a scheme since refused —
            // and the send path is where that has to be caught, because it is the thing that would
            // otherwise post to it.
            let webhook = Webhook::new(url.trim())
                .ok_or_else(|| Transport::Discord.check(url).unwrap_err())?;
            Ok(Box::new(DiscordSender::new(Some(webhook))))
        }
        Transport::Telegram => {
            let sender = TelegramSender::from_env(&ProcessEnv);
            if !sender.can_send() {
                return Err(
                    "Telegram is not configured — TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come \
                     from .env.local"
                        .to_string(),
                );
            }
            Ok(Box::new(sender))
        }
    }
}

/// Send a notification to whichever channels its group is routed to.
///
/// Returns how many deliveries were queued.
///
/// ## The fallback, and why it is here
///
/// If routing resolves to **nothing**, this queues the old `deliver.telegram` job instead — the
/// all-channels path that has always worked — and says so in the log.
///
/// That is deliberate and it is transitional. This code ships to a box that is already sending real
/// alerts about real money to a real phone, and on that box there are no channels and no routes
/// until someone opens Settings and makes some. Routing correctly to nowhere would be a silent stop
/// to every alert, which is the exact failure this whole feature was built to remove. So until a
/// group has somewhere to go, it goes where it used to.
///
/// The cost is that "I deliberately route nothing here" cannot yet be said; it reads as "not
/// configured". That is the right trade while the table is empty and the wrong one once it is not,
/// so it comes out when the routing is real — not before, and not silently.
pub async fn notify(
    state: &crate::AppState,
    group: &str,
    severity: Severity,
    key: Option<&str>,
    text: &str,
    markup: Markup,
) -> usize {
    use lyra_db::jobs::{Queue, SqliteQueue};

    let store = ChannelStore::new(state.pool.clone(), state.secret_key.as_deref().cloned());
    let queue = SqliteQueue::new(state.pool.clone());
    let now = lyra_db::jobs::now_secs();
    // Local, because quiet hours are a wall-clock idea: "do not wake me" means the hour on the
    // clock in the room, not an offset from UTC.
    let hour = i64::from(chrono::Timelike::hour(&chrono::Local::now()));

    let destinations = match store.destinations(group, severity, hour).await {
        Ok(destinations) => destinations,
        Err(e) => {
            // Reading the routing failed, which is the database failing. Falling back keeps the
            // message moving rather than losing it to an error about where to put it.
            tracing::error!(group, error = %e, "could not resolve routing; falling back");
            Vec::new()
        }
    };

    if destinations.is_empty() {
        tracing::info!(
            group,
            severity = severity.as_str(),
            "nothing is routed for this group — sending to every configured channel instead"
        );
        let job = crate::jobs::deliver::job(text.to_string(), markup);
        if let Err(e) = queue.enqueue(&job, now).await {
            tracing::error!(group, error = %e, "queueing the fallback delivery failed");
            return 0;
        }
        return 1;
    }

    let mut queued = 0;
    for channel_id in &destinations {
        let job = crate::jobs::notify::job(channel_id, key, text.to_string(), markup);
        match queue.enqueue(&job, now).await {
            Ok(_) => queued += 1,
            // One channel failing to queue must not stop the others: the point of separate jobs is
            // that they are independent, and that starts here.
            Err(e) => {
                tracing::error!(channel = %channel_id, error = %e, "queueing a delivery failed")
            }
        }
    }
    queued
}

/// Which group and how loud an alert is.
///
/// Here rather than on `AlertKind` because severity is a `lyra-db` type and `lyra-alerts` does not
/// depend on `lyra-db` — putting it there would mean either a new dependency edge or a second
/// severity enum. The mapping is the interesting part and it is small enough to read at once.
pub fn severity_of(alert: &lyra_alerts::rules::AlertKind) -> Severity {
    use lyra_alerts::rules::AlertKind;
    match alert {
        // Approaching liquidation. This is the one that should reach you at 3am, which is why
        // `Route::carries` lets critical through quiet hours.
        AlertKind::HealthFactorLow { .. } => Severity::Critical,
        // The position stopped earning. Worth knowing today, not worth waking for.
        AlertKind::OutOfRange => Severity::Warning,
        // Good news, and money you can act on when convenient.
        AlertKind::BackInRange | AlertKind::FeesReady { .. } => Severity::Info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_url_that_no_longer_passes_the_rules_is_refused_at_send_time() {
        // A row can outlive the rules that admitted it. Validating only on write would mean a host
        // that was once allowed keeps being posted to forever, and the send path is the thing
        // actually handing over the credential.
        // `.map(drop)` because `Box<dyn MessageSender>` is not `Debug`, which `expect_err` needs.
        let refused = sender_for(
            Transport::Discord,
            Some("https://evil.test/api/webhooks/1/x"),
        )
        .map(drop)
        .expect_err("an arbitrary host must not produce a sender");
        assert!(
            refused.contains("discord.com"),
            "the refusal should name the rule: {refused}"
        );

        assert!(
            sender_for(Transport::Discord, None)
                .map(drop)
                .unwrap_err()
                .contains("no stored webhook"),
            "a Discord channel with nothing stored cannot send"
        );

        assert!(
            sender_for(
                Transport::Discord,
                Some("https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaa")
            )
            .is_ok()
        );
    }

    #[test]
    fn the_groups_are_the_ones_routing_accepts() {
        // The HTTP layer validates a route's group against this list, so a typo in either place
        // would silently accept a group nothing ever delivers to.
        assert_eq!(GROUPS.len(), 3);
        for group in GROUPS {
            assert!(!group.is_empty() && group.chars().all(|c| c.is_ascii_lowercase()));
        }
    }
}
