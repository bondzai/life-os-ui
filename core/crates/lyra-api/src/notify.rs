//! The notification groups, and turning a stored channel into something that can send.
//!
//! Small on purpose for now: routing decides *which* channels a notification reaches (that lives in
//! `lyra_db::channels`), and this decides how to talk to one of them. The producers that will call
//! into here — the alert sweep, the digest, a cron — still send the way they always did; wiring them
//! through routing is the next step, and doing it before the channels can be configured would have
//! meant routing to nothing.

use lyra_alerts::channels::Transport;
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
