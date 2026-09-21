//! Discord delivery — the second channel.
//!
//! # The webhook URL is the credential
//!
//! A Discord webhook URL ends in a token: anyone holding the whole URL can post to that channel.
//! So it gets the same containment as the Telegram bot token, for the same reason — see
//! [`crate::telegram`]'s module docs, which this mirrors deliberately rather than inventing a
//! second style:
//!
//! * [`Webhook`] has a hand-written [`Debug`] that prints `[redacted]`, and no `Display`,
//!   `Serialize` or public accessor for the URL.
//! * The token is a **path segment of the URL**, so an HTTP error quoting its URL would publish
//!   it. Errors go through [`crate::telegram::SendError`] after `without_url()`, then are scrubbed.
//! * The host is checked on construction. A "which host do we post to" setting is a
//!   credential-exfiltration switch, so a URL that is not Discord's is refused outright.
//!
//! # Why an embed rather than plain text
//!
//! Plain text is what Telegram is for, and it renders a digest as a wall. Discord's value here is
//! that a message can carry structure: a coloured stripe, a title, and up to 6000 characters of
//! body across 25 fields. This module starts with the description — one embed, one message — and
//! leaves fields for when [`Message`] itself carries them.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{Value, json};

use crate::config::EnvSource;
use crate::message::{Markup, Message};
use crate::telegram::{Delivery, MessageSender, REDACTED, SendError};

/// The only host a webhook may point at.
pub const WEBHOOK_HOST: &str = "discord.com";

/// Matching Telegram's 12s: long enough for a slow link, short enough that a wedged sweep is
/// still a sweep.
const SEND_TIMEOUT: Duration = Duration::from_secs(12);

/// Discord's cap on an embed description. Longer bodies are truncated rather than rejected —
/// a brief that arrives shortened beats a brief that does not arrive.
pub const DESCRIPTION_LIMIT: usize = 4096;

/// What a truncated body ends with, so a cut is visible rather than silent.
pub const TRUNCATION_MARK: &str = "\n…";

/// A webhook URL, contained.
#[derive(Clone, PartialEq, Eq)]
pub struct Webhook {
    url: String,
}

impl Webhook {
    /// Read `DISCORD_WEBHOOK_URL`. `None` when unset or blank — the ordinary "Discord isn't set
    /// up" state, exactly as an absent Telegram token is.
    pub fn from_env(env: &dyn EnvSource) -> Option<Self> {
        Self::new(env.get("DISCORD_WEBHOOK_URL").unwrap_or_default().trim())
    }

    /// `None` unless this is a Discord webhook URL.
    ///
    /// The host check is the point: this value is posted to verbatim, so accepting any URL would
    /// turn a typo — or an edited `.env.local` — into a credential sent somewhere else entirely.
    pub fn new(url: &str) -> Option<Self> {
        if url.is_empty() {
            return None;
        }
        let rest = url.strip_prefix("https://")?;
        let host = rest.split('/').next()?;
        let ok = host == WEBHOOK_HOST || host.ends_with(&format!(".{WEBHOOK_HOST}"));
        (ok && rest.contains("/api/webhooks/")).then(|| Self {
            url: url.to_string(),
        })
    }

    /// Private: the token lives in this string and must not reach a log line or an error.
    fn url(&self) -> &str {
        &self.url
    }

    /// Replace the URL anywhere it appears in `text`.
    pub fn scrub(&self, text: &str) -> String {
        text.replace(&self.url, REDACTED)
    }
}

/// Hand-written for the same reason as [`crate::telegram::Credentials`]: a derived `Debug` would
/// publish the URL through the first `tracing::error!(?webhook)` anyone writes.
impl fmt::Debug for Webhook {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Webhook").field("url", &REDACTED).finish()
    }
}

/// Rewrite Telegram's markdown as Discord's.
///
/// The two are close enough to be dangerous. Telegram's legacy mode reads `*bold*` and `_italic_`;
/// Discord reads `**bold**` and `*italic*`. Passing one to the other unchanged turns every bold
/// heading in the digest into italics — quietly, and only visible to someone comparing the two
/// channels side by side.
///
/// Deliberately conservative: only a marker with a non-space character on both sides of a run is
/// treated as emphasis, and an unpaired marker is left alone. A stray asterisk renders as an
/// asterisk here, where Telegram would reject the whole message.
pub fn telegram_to_discord(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if (c == '*' || c == '_')
            && let Some(close) = closing_marker(&chars, i, c)
        {
            let inner: String = chars[i + 1..close].iter().collect();
            // `*bold*` -> `**bold**`, `_italic_` -> `*italic*`.
            let wrap = if c == '*' { "**" } else { "*" };
            out.push_str(wrap);
            out.push_str(&inner);
            out.push_str(wrap);
            i = close + 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The index of the marker closing a run that opens at `start`, if there is one on the same line.
fn closing_marker(chars: &[char], start: usize, marker: char) -> Option<usize> {
    // An opener needs content after it.
    if chars.get(start + 1).is_none_or(|c| c.is_whitespace()) {
        return None;
    }
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            // Emphasis does not span lines in either dialect.
            '\n' => return None,
            c if c == marker && !chars[i - 1].is_whitespace() => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// Escape Discord's markdown so plain text arrives as written.
///
/// Unlike Telegram, Discord does not reject a message with unbalanced markup — it just renders it
/// oddly. So here the text can be *escaped* rather than stripped, and a pool name keeps every
/// character it started with.
pub fn escape_discord(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if matches!(c, '*' | '_' | '`' | '~' | '|' | '\\' | '>' | '#' | '-') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Cut a body to Discord's limit, marking the cut.
fn clamp(text: &str) -> String {
    if text.chars().count() <= DESCRIPTION_LIMIT {
        return text.to_string();
    }
    let keep = DESCRIPTION_LIMIT - TRUNCATION_MARK.chars().count();
    let mut out: String = text.chars().take(keep).collect();
    out.push_str(TRUNCATION_MARK);
    out
}

/// The sender.
pub struct DiscordSender {
    webhook: Option<Webhook>,
    /// `None` only if the HTTP client could not be built — a failure, not a panic, so a broken
    /// TLS stack cannot take the alert loop down.
    client: Option<reqwest::Client>,
}

impl fmt::Debug for DiscordSender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DiscordSender")
            .field("configured", &self.can_send())
            .finish()
    }
}

impl DiscordSender {
    pub fn from_env(env: &dyn EnvSource) -> Self {
        Self::new(Webhook::from_env(env))
    }

    pub fn new(webhook: Option<Webhook>) -> Self {
        Self {
            webhook,
            client: reqwest::Client::builder()
                .timeout(SEND_TIMEOUT)
                .build()
                .ok(),
        }
    }

    pub fn can_send(&self) -> bool {
        self.webhook.is_some()
    }

    /// The body as Discord will render it.
    pub fn rendered(message: &Message) -> String {
        clamp(&match message.markup() {
            Markup::Telegram => telegram_to_discord(message.text()),
            Markup::None => escape_discord(message.text()),
        })
    }

    async fn post(&self, message: &Message) -> Delivery {
        let Some(webhook) = self.webhook.as_ref() else {
            return Delivery::NotConfigured;
        };
        let Some(client) = self.client.as_ref() else {
            return Delivery::Failed(SendError::scrubbed(
                str::to_string,
                "HTTP client unavailable",
            ));
        };

        let request = client
            .post(webhook.url())
            .json(&embed_body(&Self::rendered(message)));

        match request.send().await {
            // `without_url` first — the URL carries the token — then scrub whatever remains.
            Err(error) => Delivery::Failed(SendError::scrubbed(
                |text| webhook.scrub(text),
                error.without_url().to_string(),
            )),
            Ok(response) if response.status().is_success() => Delivery::Sent,
            // Status only. Discord echoes request content in some error bodies, so quoting the
            // body could hand the message back into a log.
            Ok(response) => Delivery::Failed(SendError::scrubbed(
                |text| webhook.scrub(text),
                format!("Discord returned HTTP {}", response.status().as_u16()),
            )),
        }
    }
}

impl MessageSender for DiscordSender {
    fn name(&self) -> &'static str {
        "discord"
    }

    fn send<'a>(
        &'a self,
        message: &'a Message,
    ) -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>> {
        Box::pin(async move {
            let delivery = self.post(message).await;
            if let Delivery::Failed(error) = &delivery {
                tracing::warn!(reason = %error, "discord send failed");
            }
            delivery
        })
    }
}

/// One embed, described.
///
/// `content` is left empty on purpose: a webhook that sets both shows the text above the embed,
/// which reads as the same thing said twice.
pub fn embed_body(description: &str) -> Value {
    json!({ "embeds": [{ "description": description }] })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like a real one, belonging to nothing.
    const FAKE: &str = "https://discord.com/api/webhooks/000000/aaaaaaaaaaaaaaaaaaaa";

    // ---------- the URL never escapes ----------

    #[test]
    fn a_webhook_must_point_at_discord() {
        assert!(Webhook::new(FAKE).is_some());
        assert!(Webhook::new("https://discordapp.com/api/webhooks/1/x").is_none());
        assert!(
            Webhook::new("https://evil.test/api/webhooks/1/x").is_none(),
            "this value is posted to verbatim — an arbitrary host is a credential handed away"
        );
        assert!(
            Webhook::new("http://discord.com/api/webhooks/1/x").is_none(),
            "plaintext would put the token on the wire"
        );
        assert!(
            Webhook::new("https://discord.com/channels/1/2").is_none(),
            "a channel link is not a webhook"
        );
        assert!(Webhook::new("").is_none());
    }

    #[test]
    fn debug_output_never_contains_the_url() {
        let webhook = Webhook::new(FAKE).expect("valid");
        let rendered = format!("{webhook:?}");
        assert!(!rendered.contains("aaaaaaaaaaaaaaaaaaaa"), "{rendered}");
        assert!(rendered.contains(REDACTED));

        // ...and nested, which is how it would actually reach a log.
        let sender = DiscordSender::new(Some(webhook));
        assert!(!format!("{sender:?}").contains("aaaaaaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn a_failure_carries_no_credential() {
        let webhook = Webhook::new(FAKE).expect("valid");
        let error = SendError::scrubbed(
            |text| webhook.scrub(text),
            format!("connecting to {FAKE} failed"),
        );
        assert!(!error.message().contains("aaaaaaaaaaaaaaaaaaaa"));
        assert!(error.message().contains(REDACTED));
    }

    // ---------- the two markdowns are not the same markdown ----------

    #[test]
    fn telegram_bold_becomes_discord_bold() {
        // The quiet bug this exists to stop: Telegram's `*bold*` is Discord's *italic*, so the
        // digest's every heading would have arrived emphasised the wrong way.
        assert_eq!(
            telegram_to_discord("*Net worth* today"),
            "**Net worth** today"
        );
        assert_eq!(
            telegram_to_discord("_since yesterday_"),
            "*since yesterday*"
        );
    }

    #[test]
    fn an_unpaired_marker_is_left_alone() {
        // Telegram would reject this outright; Discord renders it, so it survives as typed.
        assert_eq!(telegram_to_discord("2 * 3 = 6"), "2 * 3 = 6");
        assert_eq!(telegram_to_discord("WETH/USD*C"), "WETH/USD*C");
        assert_eq!(
            telegram_to_discord("*opens but\nnever closes"),
            "*opens but\nnever closes",
            "emphasis does not span lines in either dialect"
        );
    }

    #[test]
    fn plain_text_is_escaped_rather_than_stripped() {
        // The difference from Telegram worth knowing: Discord does not reject unbalanced markup,
        // so a pool name keeps every character instead of losing it.
        let rendered = DiscordSender::rendered(&Message::plain("WETH/USD*C _v3_"));
        assert_eq!(rendered, "WETH/USD\\*C \\_v3\\_");
        assert!(
            rendered.contains('*') && rendered.contains('_'),
            "nothing was dropped, only escaped: {rendered}"
        );
    }

    #[test]
    fn authored_markup_is_translated_not_escaped() {
        assert_eq!(
            DiscordSender::rendered(&Message::telegram_markup("*Net worth* $1")),
            "**Net worth** $1"
        );
    }

    // ---------- limits ----------

    #[test]
    fn a_body_past_the_limit_is_cut_visibly() {
        let long = Message::plain("a".repeat(DESCRIPTION_LIMIT + 500));
        let rendered = DiscordSender::rendered(&long);
        assert_eq!(rendered.chars().count(), DESCRIPTION_LIMIT);
        assert!(
            rendered.ends_with(TRUNCATION_MARK),
            "a silent cut reads as the brief simply ending early"
        );
    }

    #[test]
    fn an_unconfigured_sender_reports_it_rather_than_failing() {
        let sender = DiscordSender::new(None);
        assert!(!sender.can_send());
        let delivery = futures_lite_block(sender.send(&Message::plain("x")));
        assert_eq!(delivery, Delivery::NotConfigured);
    }

    /// The crate has no async test runtime; this drives one ready future to completion, which is
    /// all the unconfigured path needs — it never awaits the network.
    fn futures_lite_block<F: Future<Output = Delivery>>(future: F) -> Delivery {
        use std::task::{Context, Poll, Waker};
        let mut future = std::pin::pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(delivery) => delivery,
            Poll::Pending => panic!("the unconfigured path must not await anything"),
        }
    }
}
