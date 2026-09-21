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
use crate::telegram::{Delivery, MessageSender, TEST_MESSAGE, TelegramSender};

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
