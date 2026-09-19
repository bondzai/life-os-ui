//! Telegram delivery — port of the outbound half of `notify.py` (`tg_send`, `send_test`,
//! `can_send`, `configured`, `digest_enabled`, `_token`/`_chat`).
//!
//! # The token is the bot
//!
//! `TELEGRAM_BOT_TOKEN` is not a password protecting an account — it *is* the ability to post as
//! the bot to whoever holds it. So it is contained rather than merely handled carefully:
//!
//! * [`Credentials`] has a hand-written [`Debug`] that prints `[redacted]`, and no `Display`,
//!   `Serialize` or public accessor. A `tracing` field or a `{:?}` in a future error cannot leak
//!   it, because there is nothing to leak.
//! * The token is a **path segment of the API URL**, so an HTTP error that quotes its URL would
//!   publish it. Every error goes through [`SendError::new`], which drops the URL and then scrubs
//!   the token out of whatever text remains. The struct has no other constructor.
//! * Nothing here logs the request or the response body.
//!
//! # Unconfigured is normal
//!
//! The mini PC may run for months with no Telegram set up. That is not an error state: with no
//! token, [`TelegramSender::send`] returns [`Delivery::NotConfigured`] — no send, no panic, no
//! log line, every time. Only a *configured* sender that actually fails is worth a warning.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{Value, json};

use crate::config::EnvSource;
use crate::digest::strip_markdown;
use crate::message::{Markup, Message};

/// Telegram's API host. A constant, not configuration: a "which host do we post the token to"
/// setting is a credential-exfiltration switch.
pub const API_BASE: &str = "https://api.telegram.org";

/// `notify.py` posts with a 12s timeout.
const SEND_TIMEOUT: Duration = Duration::from_secs(12);

/// What replaces a credential that turns up in text on its way out.
pub const REDACTED: &str = "[redacted]";

/// The message `send_test` delivers — the "is this thing on?" ping behind the settings button.
pub const TEST_MESSAGE: &str = "🔔 *Proof of Wealth connected.*\nYou'll get a ping when an LP \
position goes out of range — and when it comes back.";

// ===========================================================================
// Credentials
// ===========================================================================

/// A bot token and the chat it may post to.
///
/// Constructed only from a complete pair: Python treats an empty string as unset, and half a
/// credential is not a credential.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    token: String,
    chat_id: String,
}

impl Credentials {
    /// Read `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. `None` when either is missing or blank —
    /// the ordinary "Telegram isn't set up" state, not a failure.
    pub fn from_env(env: &dyn EnvSource) -> Option<Self> {
        let token = env.get("TELEGRAM_BOT_TOKEN").unwrap_or_default();
        let chat_id = env.get("TELEGRAM_CHAT_ID").unwrap_or_default();
        Self::new(token.trim(), chat_id.trim())
    }

    /// `None` unless both halves are present.
    pub fn new(token: &str, chat_id: &str) -> Option<Self> {
        (!token.is_empty() && !chat_id.is_empty()).then(|| Self {
            token: token.to_string(),
            chat_id: chat_id.to_string(),
        })
    }

    /// The destination chat. Not secret in the way the token is — it identifies a recipient
    /// rather than granting the ability to post — but it is still never logged.
    pub fn chat_id(&self) -> &str {
        &self.chat_id
    }

    /// The API endpoint for a method. Private: the token lives in this string, so it must not
    /// escape into an error, a log line or a metric label.
    fn method_url(&self, api_base: &str, method: &str) -> String {
        format!("{api_base}/bot{}/{method}", self.token)
    }

    /// Replace the token anywhere it appears in `text`.
    pub fn scrub(&self, text: &str) -> String {
        text.replace(&self.token, REDACTED)
    }
}

/// Deliberately hand-written: `#[derive(Debug)]` would print the token into any `{:?}`, and the
/// first `tracing::error!(?creds)` written by a future maintainer would publish it to the logs.
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("token", &REDACTED)
            .field("chat_id", &REDACTED)
            .finish()
    }
}

// ===========================================================================
// Outcomes
// ===========================================================================

/// A delivery failure, with the credential already removed.
///
/// The inner string is private and there is exactly one constructor, so a message that has not
/// been scrubbed cannot exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendError(String);

impl SendError {
    /// Build a failure message, running it through a channel's own scrubber first.
    ///
    /// Generalised from the original Telegram-only constructor once a second channel arrived with
    /// a differently shaped credential. The invariant it was written to hold is unchanged: making
    /// one *requires* handing over the scrubber, so an unscrubbed message still cannot exist.
    /// Text that never touched a credential passes [`str::to_string`] and says so at the call
    /// site.
    pub(crate) fn scrubbed(scrub: impl FnOnce(&str) -> String, message: impl Into<String>) -> Self {
        Self(scrub(&message.into()))
    }

    /// Build a failure message, stripping the token if the source text carries it.
    fn new(credentials: Option<&Credentials>, message: impl Into<String>) -> Self {
        match credentials {
            Some(credentials) => Self::scrubbed(|text| credentials.scrub(text), message),
            None => Self::scrubbed(str::to_string, message),
        }
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SendError {}

/// What became of a message.
///
/// Three states rather than a bool, because "we never had a token" and "Telegram rejected it" are
/// different facts: the first is the normal state of an un-set-up box and the API surfaces it as
/// a prompt to configure, while the second is a real failure worth showing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    /// No token and/or no chat id. Nothing was attempted.
    NotConfigured,
    Failed(SendError),
}

impl Delivery {
    pub fn is_sent(&self) -> bool {
        matches!(self, Delivery::Sent)
    }

    /// The Python `tg_send` contract: `True` only on a successful send.
    pub fn as_bool(&self) -> bool {
        self.is_sent()
    }

    /// A short, credential-free reason, or `None` when the send succeeded.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Delivery::Sent => None,
            Delivery::NotConfigured => {
                Some("Telegram is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)")
            }
            Delivery::Failed(error) => Some(error.message()),
        }
    }
}

// ===========================================================================
// The sender
// ===========================================================================

/// Anything that can deliver a message.
///
/// The seam that keeps the test suite off the network: tests drive a recording double, and no
/// test in this crate can reach `api.telegram.org` even by accident.
///
/// **Boxed rather than `impl Future`,** which costs an allocation per send and buys dyn-safety.
/// A return-position `impl Trait` cannot be held as `Box<dyn MessageSender>`, and fanning one
/// alert out to several channels is exactly a list of senders. At one message per alert on a
/// 15-minute sweep, the allocation is not worth a thought.
pub trait MessageSender: Send + Sync {
    /// What to call this channel in a log line. Never the credential, obviously.
    fn name(&self) -> &'static str;

    fn send<'a>(
        &'a self,
        message: &'a Message,
    ) -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>>;
}

/// The real sender.
pub struct TelegramSender {
    credentials: Option<Credentials>,
    /// `None` only if the HTTP client could not be built — reported as a failure rather than a
    /// panic, because a broken TLS stack should not take the whole alert loop down.
    client: Option<reqwest::Client>,
    api_base: String,
}

impl fmt::Debug for TelegramSender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TelegramSender")
            .field("configured", &self.can_send())
            .field("api_base", &self.api_base)
            .finish()
    }
}

impl TelegramSender {
    /// Build from the environment. Always succeeds: no credentials simply means nothing is sent.
    pub fn from_env(env: &dyn EnvSource) -> Self {
        Self::new(Credentials::from_env(env))
    }

    pub fn new(credentials: Option<Credentials>) -> Self {
        Self {
            credentials,
            client: reqwest::Client::builder()
                .timeout(SEND_TIMEOUT)
                .build()
                .ok(),
            api_base: API_BASE.to_string(),
        }
    }

    /// Point at a different host. For tests and self-hosted bot APIs only.
    pub fn with_api_base(mut self, api_base: impl Into<String>) -> Self {
        self.api_base = api_base.into();
        self
    }

    /// Enough to deliver a message — token and chat both present.
    pub fn can_send(&self) -> bool {
        self.credentials.is_some()
    }

    /// The "is this thing on?" ping behind the settings test button.
    pub async fn send_test(&self) -> Delivery {
        self.send(&Message::telegram_markup(TEST_MESSAGE)).await
    }

    /// The text as this transport will actually send it.
    ///
    /// [`Markup::None`] goes through [`strip_markdown`] rather than backslash-escaping: removal
    /// cannot produce an unbalanced entity, and Telegram's legacy parser is unforgiving enough
    /// that "cannot fail" beats "keeps every character". A dropped `*` costs a glyph; a rejected
    /// message costs the whole alert.
    fn rendered(message: &Message) -> String {
        match message.markup() {
            Markup::Telegram => message.text().to_string(),
            Markup::None => strip_markdown(message.text()),
        }
    }

    async fn post(&self, message: &Message) -> Delivery {
        let text = &Self::rendered(message);
        let Some(credentials) = self.credentials.as_ref() else {
            return Delivery::NotConfigured;
        };
        let Some(client) = self.client.as_ref() else {
            return Delivery::Failed(SendError::new(None, "HTTP client unavailable"));
        };

        let request = client
            .post(credentials.method_url(&self.api_base, "sendMessage"))
            .json(&send_message_body(credentials.chat_id(), text));

        match request.send().await {
            // `without_url` first (the URL contains the token), then scrub whatever is left in
            // case a future reqwest version words the message differently. Belt and braces, on
            // purpose: this is the one error path that touches the credential.
            Err(error) => Delivery::Failed(SendError::new(
                Some(credentials),
                error.without_url().to_string(),
            )),
            Ok(response) if response.status().is_success() => Delivery::Sent,
            // Status only — the response body is not quoted, so nothing echoed back can leak.
            Ok(response) => Delivery::Failed(SendError::new(
                Some(credentials),
                format!("Telegram returned HTTP {}", response.status().as_u16()),
            )),
        }
    }
}

impl MessageSender for TelegramSender {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn send<'a>(
        &'a self,
        message: &'a Message,
    ) -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>> {
        Box::pin(async move {
            let delivery = self.post(message).await;
            if let Delivery::Failed(error) = &delivery {
                // Configured-but-failing is worth a line. Unconfigured stays silent for months.
                tracing::warn!(reason = %error, "telegram send failed");
            }
            delivery
        })
    }
}

/// The `sendMessage` payload.
///
/// `parse_mode: Markdown` is what makes the digest's `*bold*` render — and what makes an
/// unescaped `*` in an on-chain token name able to break a message (see
/// [`crate::digest::strip_markdown`]). `disable_web_page_preview` keeps a pasted URL from
/// expanding into a card.
pub fn send_message_body(chat_id: &str, text: &str) -> Value {
    json!({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": true,
    })
}

// ===========================================================================
// Readiness predicates — ported from notify.py
// ===========================================================================

/// Enough to deliver a message (token + chat). `notify.can_send`.
pub fn can_send(credentials: Option<&Credentials>) -> bool {
    credentials.is_some()
}

/// Fully wired for monitoring — deliverable *and* at least one wallet to watch.
/// `notify.configured`.
pub fn configured(credentials: Option<&Credentials>, has_wallets: bool) -> bool {
    can_send(credentials) && has_wallets
}

/// The daily brief is on when we can deliver, an hour is set, and there is something to report.
/// `notify.digest_enabled`.
pub fn digest_enabled(
    credentials: Option<&Credentials>,
    digest_hour: Option<u32>,
    has_wallets: bool,
    kucoin_configured: bool,
) -> bool {
    can_send(credentials) && digest_hour.is_some() && (has_wallets || kucoin_configured)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::config::MapEnv;

    const DUMMY_TOKEN: &str = "123456789:AAdummy-not-a-real-token-abcdefghijklmno";
    const DUMMY_CHAT: &str = "987654321";

    fn creds() -> Credentials {
        Credentials::new(DUMMY_TOKEN, DUMMY_CHAT).expect("both halves present")
    }

    /// A sender that records instead of sending. Nothing in this crate's tests touches the wire.
    #[derive(Debug, Default)]
    struct RecordingSender {
        sent: Mutex<Vec<String>>,
        outcome: Option<Delivery>,
    }

    impl RecordingSender {
        fn messages(&self) -> Vec<String> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl MessageSender for RecordingSender {
        fn name(&self) -> &'static str {
            "recording"
        }

        fn send<'a>(
            &'a self,
            message: &'a Message,
        ) -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>> {
            Box::pin(async move {
                // Records what the *author* handed over, not what a transport made of it — the
                // escaping is TelegramSender's job and is asserted against that sender directly.
                self.sent.lock().unwrap().push(message.text().to_string());
                self.outcome.clone().unwrap_or(Delivery::Sent)
            })
        }
    }

    // ---------- escaping is the transport's job ----------

    #[test]
    fn a_pool_name_carrying_markdown_cannot_break_the_message() {
        // The live failure this type exists for: `/positions` builds its reply from on-chain
        // names, the reply went out with `parse_mode: Markdown`, and one `*` made Telegram
        // reject the whole request with `can't parse entities` — so the answer was silently
        // never delivered.
        let reply = Message::plain("WETH/USD*C out of range [pool] _v3_");
        let rendered = TelegramSender::rendered(&reply);

        for meta in ['*', '_', '`', '[', ']', '(', ')', '~'] {
            assert!(
                !rendered.contains(meta),
                "{meta:?} survived into a Markdown message: {rendered}"
            );
        }
        assert!(
            rendered.contains("WETH/USDC out of range"),
            "the name itself must still be readable: {rendered}"
        );
    }

    #[test]
    fn authored_emphasis_still_reaches_telegram() {
        // The other half: the digest means its `*bold*`, and escaping that would turn every
        // brief into literal asterisks.
        let brief = Message::telegram_markup("*Net worth* $1,234\n_since yesterday_");
        assert_eq!(
            TelegramSender::rendered(&brief),
            "*Net worth* $1,234\n_since yesterday_"
        );
    }

    #[test]
    fn the_sender_can_be_held_as_a_trait_object() {
        // Dyn-safety is the whole point of boxing the future: fanning one alert out to Telegram
        // and Discord is a list of senders, and a list needs `dyn`.
        let senders: Vec<Box<dyn MessageSender>> = vec![
            Box::new(TelegramSender::new(None)),
            Box::new(RecordingSender::default()),
        ];
        assert_eq!(senders.len(), 2);
    }

    // ---------- the token never escapes ----------

    #[test]
    fn debug_output_never_contains_the_token() {
        let rendered = format!("{:?}", creds());
        assert!(
            !rendered.contains(DUMMY_TOKEN),
            "Debug leaked the token: {rendered}"
        );
        assert!(!rendered.contains(DUMMY_CHAT), "Debug leaked the chat id");
        assert!(rendered.contains(REDACTED));

        // ...including when it is nested inside another Debug, which is how it would actually
        // escape: `tracing::error!(?sender)`.
        let sender = TelegramSender::new(Some(creds()));
        let rendered = format!("{sender:?}");
        assert!(
            !rendered.contains(DUMMY_TOKEN),
            "sender Debug leaked: {rendered}"
        );
        assert!(rendered.contains("configured: true"));
    }

    #[test]
    fn a_formatted_error_never_contains_the_token() {
        let credentials = creds();
        // The realistic leak: reqwest quotes the URL it failed to reach, and the token is a path
        // segment of that URL.
        let url = credentials.method_url(API_BASE, "sendMessage");
        assert!(
            url.contains(DUMMY_TOKEN),
            "precondition: the URL holds the token"
        );

        let error = SendError::new(
            Some(&credentials),
            format!("error sending request for url ({url}): connection refused"),
        );
        for rendered in [
            error.to_string(),
            format!("{error:?}"),
            error.message().to_string(),
        ] {
            assert!(
                !rendered.contains(DUMMY_TOKEN),
                "a formatted error leaked the bot token: {rendered}"
            );
            assert!(rendered.contains(REDACTED));
        }
        // The useful part of the diagnosis survives the scrub.
        assert!(error.message().contains("connection refused"));

        // And through the Delivery the API layer actually reads.
        let delivery = Delivery::Failed(error);
        assert!(!delivery.reason().unwrap().contains(DUMMY_TOKEN));
        assert!(!format!("{delivery:?}").contains(DUMMY_TOKEN));
    }

    #[test]
    fn the_url_places_the_token_where_telegram_expects_it() {
        assert_eq!(
            creds().method_url(API_BASE, "sendMessage"),
            format!("https://api.telegram.org/bot{DUMMY_TOKEN}/sendMessage")
        );
    }

    // ---------- unconfigured is normal ----------

    #[tokio::test]
    async fn with_no_token_nothing_is_sent_and_nothing_breaks() {
        let sender = TelegramSender::from_env(&MapEnv::new::<[(&str, &str); 0], _, _>([]));
        assert!(!sender.can_send());
        // Repeated calls stay quiet — this is the mini PC's normal state for months.
        for _ in 0..3 {
            assert_eq!(
                sender.send(&Message::plain("anything")).await,
                Delivery::NotConfigured
            );
            assert_eq!(sender.send_test().await, Delivery::NotConfigured);
        }
        assert!(!sender.send(&Message::plain("x")).await.is_sent());
        assert!(
            sender
                .send(&Message::plain("x"))
                .await
                .reason()
                .unwrap()
                .contains("not configured")
        );
    }

    #[test]
    fn half_a_credential_is_no_credential() {
        let cases = [
            (vec![("TELEGRAM_BOT_TOKEN", DUMMY_TOKEN)], "token only"),
            (vec![("TELEGRAM_CHAT_ID", DUMMY_CHAT)], "chat only"),
            (
                vec![("TELEGRAM_BOT_TOKEN", ""), ("TELEGRAM_CHAT_ID", DUMMY_CHAT)],
                "empty token",
            ),
            (
                vec![
                    ("TELEGRAM_BOT_TOKEN", DUMMY_TOKEN),
                    ("TELEGRAM_CHAT_ID", "  "),
                ],
                "blank chat",
            ),
        ];
        for (vars, what) in cases {
            let env = MapEnv::new(vars);
            assert!(
                Credentials::from_env(&env).is_none(),
                "{what} must not count as configured"
            );
        }
        let env = MapEnv::new(vec![
            ("TELEGRAM_BOT_TOKEN", format!("  {DUMMY_TOKEN}  ")),
            ("TELEGRAM_CHAT_ID", format!("  {DUMMY_CHAT}  ")),
        ]);
        let parsed = Credentials::from_env(&env).expect("surrounding whitespace is trimmed");
        assert_eq!(parsed.chat_id(), DUMMY_CHAT);
    }

    // ---------- readiness ----------

    #[test]
    fn readiness_predicates_match_python() {
        let some = creds();
        assert!(can_send(Some(&some)));
        assert!(!can_send(None));

        // configured() additionally needs something to watch.
        assert!(configured(Some(&some), true));
        assert!(!configured(Some(&some), false));
        assert!(!configured(None, true));

        // digest_enabled() needs an hour AND a source of figures.
        assert!(digest_enabled(Some(&some), Some(9), true, false));
        assert!(digest_enabled(Some(&some), Some(9), false, true));
        assert!(!digest_enabled(Some(&some), Some(9), false, false));
        assert!(!digest_enabled(Some(&some), None, true, true));
        assert!(!digest_enabled(None, Some(9), true, true));
    }

    // ---------- the payload ----------

    #[test]
    fn the_payload_matches_what_notify_py_posts() {
        let body = send_message_body(DUMMY_CHAT, "*hi*");
        assert_eq!(
            body,
            json!({
                "chat_id": DUMMY_CHAT,
                "text": "*hi*",
                "parse_mode": "Markdown",
                "disable_web_page_preview": true,
            })
        );
    }

    // ---------- the double ----------

    #[tokio::test]
    async fn the_recording_double_captures_what_would_have_been_sent() {
        let sender = RecordingSender::default();
        assert_eq!(sender.send(&Message::plain("first")).await, Delivery::Sent);
        assert_eq!(sender.send(&Message::plain("second")).await, Delivery::Sent);
        assert_eq!(sender.messages(), vec!["first", "second"]);

        let failing = RecordingSender {
            outcome: Some(Delivery::Failed(SendError::new(None, "boom"))),
            ..Default::default()
        };
        assert!(!failing.send(&Message::plain("nope")).await.is_sent());
        assert_eq!(failing.messages(), vec!["nope"]);
    }
}
