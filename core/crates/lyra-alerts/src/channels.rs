//! Every channel an alert goes to.
//!
//! Alerting used to be one concrete [`TelegramSender`], rebuilt from the environment at each of
//! six call sites. Adding a second destination meant either threading two senders through all of
//! them or putting the list in one place; this is the list.
//!
//! # Delivered means delivered *somewhere*
//!
//! [`Channels::send`] reports success when **any** channel took the message. That is the whole
//! point of having two: an alert that reached your phone has done its job, and failing the sweep
//! because the second channel was down would turn redundancy into a new way to lose an alert.
//! A channel that fails is logged by name — so a Discord outage is visible — but it cannot mask
//! a Telegram delivery that worked.
//!
//! The inverse matters just as much: when *nothing* is configured the result is
//! [`Delivery::NotConfigured`], never a failure. A box with no channels set up is the ordinary
//! state of a fresh install, not a fault.

use crate::config::EnvSource;
use crate::discord::DiscordSender;
use crate::message::Message;
use crate::telegram::{Delivery, MessageSender, SendError, TEST_MESSAGE, TelegramSender};

/// The channels this box can reach.
pub struct Channels {
    senders: Vec<Box<dyn MessageSender>>,
}

impl std::fmt::Debug for Channels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Channels")
            .field("configured", &self.names())
            .finish()
    }
}

impl Channels {
    /// Read every channel from the environment, keeping only the configured ones.
    ///
    /// An unconfigured sender is dropped here rather than kept and skipped later, so
    /// [`Self::can_send`] is a question about the list's length instead of a poll of its members.
    pub fn from_env(env: &dyn EnvSource) -> Self {
        let mut senders: Vec<Box<dyn MessageSender>> = Vec::new();

        let telegram = TelegramSender::from_env(env);
        if telegram.can_send() {
            senders.push(Box::new(telegram));
        }
        let discord = DiscordSender::from_env(env);
        if discord.can_send() {
            senders.push(Box::new(discord));
        }

        Self { senders }
    }

    /// Build from an explicit list. For tests, and for a caller that wants one channel only.
    pub fn new(senders: Vec<Box<dyn MessageSender>>) -> Self {
        Self { senders }
    }

    /// Whether anything at all is configured.
    pub fn can_send(&self) -> bool {
        !self.senders.is_empty()
    }

    /// The configured channels, in delivery order. For logs and status, never for routing.
    pub fn names(&self) -> Vec<&'static str> {
        self.senders.iter().map(|s| s.name()).collect()
    }

    /// Each channel on its own, so a caller can send to them one at a time and keep the outcomes
    /// apart.
    ///
    /// [`Self::send`] cannot do that and cannot be fixed to: it has one return value for N
    /// channels, so it must either report success when only some took the message — losing the
    /// rest silently, which is what it does — or report failure and have the retry re-send to the
    /// channel that already succeeded. The only way out is for the caller to own the loop, because
    /// only the caller knows what it already did.
    pub fn each(&self) -> impl Iterator<Item = &dyn MessageSender> {
        self.senders.iter().map(|sender| sender.as_ref())
    }

    /// Send to every channel.
    ///
    /// Sequential rather than concurrent: there are two of them, each already has a 12s timeout,
    /// and a sweep that fans out in parallel would need the senders behind an `Arc` for no gain
    /// anyone could measure.
    pub async fn send(&self, message: &Message) -> Delivery {
        if self.senders.is_empty() {
            return Delivery::NotConfigured;
        }

        let mut first_failure = None;
        let mut delivered = false;

        for sender in &self.senders {
            match sender.send(message).await {
                Delivery::Sent => delivered = true,
                // A configured sender reporting NotConfigured should be impossible — `from_env`
                // drops those — but treating it as a silent non-delivery is the safe reading.
                Delivery::NotConfigured => {}
                Delivery::Failed(error) => {
                    tracing::warn!(
                        channel = sender.name(),
                        reason = %error,
                        "a channel did not take the message"
                    );
                    first_failure.get_or_insert(error);
                }
            }
        }

        match (delivered, first_failure) {
            (true, _) => Delivery::Sent,
            (false, Some(error)) => Delivery::Failed(error),
            (false, None) => Delivery::NotConfigured,
        }
    }

    /// The "is this thing on?" ping, to every channel at once.
    pub async fn send_test(&self) -> Delivery {
        self.send(&Message::telegram_markup(TEST_MESSAGE)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::SendError;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        label: &'static str,
        outcome: Option<Delivery>,
        seen: Mutex<Vec<String>>,
    }

    impl Fake {
        fn ok(label: &'static str) -> Self {
            Self {
                label,
                outcome: None,
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl MessageSender for Fake {
        fn name(&self) -> &'static str {
            self.label
        }

        fn send<'a>(
            &'a self,
            message: &'a Message,
        ) -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push(message.text().to_string());
                self.outcome.clone().unwrap_or(Delivery::Sent)
            })
        }
    }

    #[test]
    fn a_transport_refuses_a_credential_and_says_which_rule() {
        use super::Transport;
        let ok = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaa";
        assert!(Transport::Discord.check(ok).is_ok());

        for (bad, why) in [
            (
                "https://evil.test/api/webhooks/1/x",
                "an arbitrary host is a credential handed away",
            ),
            (
                "http://discord.com/api/webhooks/1/x",
                "plaintext would put the token on the wire",
            ),
            (
                "https://discordapp.com/api/webhooks/1/x",
                "the legacy domain is not the allowlist",
            ),
            ("not a url", "not a URL at all"),
        ] {
            let refused = Transport::Discord.check(bad).expect_err(why);
            assert!(
                refused.contains("discord.com") && refused.contains("https"),
                "the message must name the rule, not just say invalid: {refused}"
            );
        }

        // Telegram stores nothing, and says so rather than silently accepting anything.
        assert!(!Transport::Telegram.stores_its_own_credential());
        assert!(Transport::Telegram.check(ok).is_err());

        assert_eq!(Transport::parse("discord"), Some(Transport::Discord));
        assert_eq!(Transport::parse("carrier-pigeon"), None);
    }

    fn failing(label: &'static str) -> Fake {
        Fake {
            label,
            outcome: Some(Delivery::Failed(SendError::scrubbed(
                str::to_string,
                "upstream said no",
            ))),
            seen: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn a_message_reaches_every_channel() {
        let channels = Channels::new(vec![Box::new(Fake::ok("a")), Box::new(Fake::ok("b"))]);
        assert_eq!(channels.names(), vec!["a", "b"]);
        assert_eq!(
            channels.send(&Message::plain("hello")).await,
            Delivery::Sent
        );
    }

    #[tokio::test]
    async fn one_channel_failing_does_not_lose_the_alert() {
        // The reason two channels exist. If Discord is down, the alert still reached the phone,
        // and reporting failure here would make the sweep record an error for a delivered alert.
        let channels = Channels::new(vec![Box::new(failing("down")), Box::new(Fake::ok("up"))]);
        assert_eq!(channels.send(&Message::plain("x")).await, Delivery::Sent);
    }

    #[tokio::test]
    async fn every_channel_failing_is_a_failure() {
        let channels = Channels::new(vec![Box::new(failing("a")), Box::new(failing("b"))]);
        assert!(matches!(
            channels.send(&Message::plain("x")).await,
            Delivery::Failed(_)
        ));
    }

    #[tokio::test]
    async fn no_channels_is_not_a_failure() {
        // A fresh box with nothing set up must stay quiet rather than log an error every sweep.
        let channels = Channels::new(Vec::new());
        assert!(!channels.can_send());
        assert_eq!(
            channels.send(&Message::plain("x")).await,
            Delivery::NotConfigured
        );
    }

    #[tokio::test]
    async fn from_env_keeps_only_what_is_configured() {
        use crate::config::MapEnv;

        let none = Channels::from_env(&MapEnv::default());
        assert!(!none.can_send(), "an empty environment configures nothing");

        let discord_only = MapEnv::new([(
            "DISCORD_WEBHOOK_URL",
            "https://discord.com/api/webhooks/1/aaaaaaaaaaaa",
        )]);
        let channels = Channels::from_env(&discord_only);
        assert_eq!(
            channels.names(),
            vec!["discord"],
            "Telegram is absent, so it is not in the list at all"
        );
    }
}

/// Which kinds of destination exist, and what a valid credential for each looks like.
///
/// One place, because the alternative is the HTTP layer knowing that Discord URLs must be https on
/// `discord.com` while the sender knows it too — and then only one of them learning about the next
/// transport. `Webhook::new` is still the thing that decides; this only routes the question to it.
///
/// **A UI that accepted any URL would undo a guard this crate already has.** `discord.rs` refuses
/// every host but `discord.com`, refuses plaintext, and its test says why: the URL is posted to
/// verbatim, so an arbitrary host is a credential handed away. Making the URL configurable is not
/// the same as making it unconstrained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Telegram,
    Discord,
}

impl Transport {
    pub const ALL: [Transport; 2] = [Self::Telegram, Self::Discord];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Telegram => "telegram",
            Self::Discord => "discord",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == text)
    }

    /// Whether a channel of this kind keeps its credential in its own row.
    ///
    /// Telegram does not: a bot token is a stronger credential than a room webhook, there is only
    /// one of it, and moving it out of `.env.local` would buy nothing. So a Telegram channel is a
    /// row that names the chat and reads its token from the environment, and the UI shows that
    /// rather than an empty field that looks broken.
    pub fn stores_its_own_credential(self) -> bool {
        match self {
            Self::Telegram => false,
            Self::Discord => true,
        }
    }

    /// Whether this credential is acceptable, and if not, what to tell the person who typed it.
    ///
    /// The message names the rule rather than saying "invalid": a pasted webhook is usually right
    /// and the mistake is usually specific — the wrong domain, or `http` from an old note.
    pub fn check(self, secret: &str) -> Result<(), String> {
        match self {
            Self::Discord => match crate::discord::Webhook::new(secret.trim()) {
                Some(_) => Ok(()),
                None => Err(format!(
                    "a Discord webhook must be an https URL on {} — copy it from \
                     Channel → Integrations → Webhooks",
                    crate::discord::WEBHOOK_HOST
                )),
            },
            // Nothing is stored for Telegram, so there is nothing to check. Said explicitly rather
            // than accepting anything, so adding a transport here is a decision and not an
            // omission.
            Self::Telegram => Err(
                "a Telegram channel takes its token from the environment, not from a stored \
                 credential"
                    .to_string(),
            ),
        }
    }
}

/// Test doubles for callers that need a channel with an outcome they choose.
///
/// This lives here, and is `pub` rather than `#[cfg(test)]`, because [`SendError`] deliberately
/// cannot be built from outside this crate: its constructor takes a scrubber so that an unscrubbed
/// failure message cannot exist. A caller that wanted to test "Discord failed and Telegram did
/// not" would otherwise have to widen that constructor, trading a real invariant for a test — so
/// the crate hands out the double instead of the key. `#[cfg(test)]` would not do: it does not
/// cross a crate boundary.
pub mod testing {
    use super::{Delivery, Message, MessageSender, SendError};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A channel that returns outcomes from a script, and counts what it was asked to send.
    ///
    /// The count is usually the assertion that matters: "was Telegram asked twice" is a question no
    /// amount of checking a job's status can answer.
    pub struct ScriptedSender {
        name: &'static str,
        /// Consumed one per call; the last entry repeats, so a one-entry script is a constant.
        outcomes: Mutex<Vec<Delivery>>,
        sends: std::sync::Arc<AtomicUsize>,
    }

    impl ScriptedSender {
        /// Always takes the message.
        pub fn sending(name: &'static str) -> Self {
            Self::scripted(name, vec![Delivery::Sent])
        }

        /// Always fails, with a retryable error.
        pub fn failing(name: &'static str, reason: &str) -> Self {
            Self::scripted(name, vec![Self::failure(reason)])
        }

        /// Fails the given number of times, then takes it — a router reboot, which is the case the
        /// queue's backoff exists for.
        pub fn failing_then_sending(name: &'static str, failures: usize, reason: &str) -> Self {
            let mut script: Vec<Delivery> = (0..failures).map(|_| Self::failure(reason)).collect();
            script.push(Delivery::Sent);
            Self::scripted(name, script)
        }

        pub fn scripted(name: &'static str, outcomes: Vec<Delivery>) -> Self {
            Self {
                name,
                outcomes: Mutex::new(outcomes),
                sends: std::sync::Arc::new(AtomicUsize::new(0)),
            }
        }

        /// How many times this channel was asked to send.
        pub fn sends(&self) -> usize {
            self.sends.load(Ordering::SeqCst)
        }

        /// A handle on the send count that outlives the move into [`super::Channels`].
        ///
        /// `Channels` owns its senders, so a test cannot hold the sender itself and still hand it
        /// over. Sharing the counter rather than the sender keeps that ownership honest and avoids
        /// a blanket `MessageSender for Arc<T>` that only tests would ever want.
        pub fn counter(&self) -> std::sync::Arc<AtomicUsize> {
            std::sync::Arc::clone(&self.sends)
        }

        fn failure(reason: &str) -> Delivery {
            // `str::to_string` is the documented scrubber for text that never touched a credential,
            // which a test's own string never has.
            Delivery::Failed(SendError::scrubbed(str::to_string, reason.to_string()))
        }
    }

    impl MessageSender for ScriptedSender {
        fn name(&self) -> &'static str {
            self.name
        }

        fn send<'a>(
            &'a self,
            _message: &'a Message,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Delivery> + Send + 'a>> {
            Box::pin(async move {
                self.sends.fetch_add(1, Ordering::SeqCst);
                let mut script = self.outcomes.lock().unwrap();
                if script.len() > 1 {
                    script.remove(0)
                } else {
                    script.first().cloned().unwrap_or(Delivery::Sent)
                }
            })
        }
    }
}
