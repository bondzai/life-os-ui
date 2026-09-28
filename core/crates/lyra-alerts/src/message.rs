//! A message before it has a channel.
//!
//! Everything that decides *what* to say — [`crate::rules`] and [`crate::digest`] — already works
//! in raw numbers and plain sentences. What was missing is a way to hand one to a sender without
//! having already chosen that sender's markup. `render_alert` returned a `String` with Telegram's
//! `*bold*` baked in, so a second channel could only receive Telegram-flavoured text and hope.
//!
//! # Escaping belongs to the sender, not the author
//!
//! This is the bug the type is really here to fix. Bot command replies are built from on-chain
//! data — pool names, token symbols — and went out with `parse_mode: Markdown` set. One `*` in a
//! pool name and Telegram rejects the whole request with `can't parse entities`, so the reply is
//! **silently never delivered**; it surfaces only as `delivered = false` in a log line. The
//! comment on those builders says "plain text — no Markdown", and it was right; the transport
//! simply had no way to know.
//!
//! So a [`Message`] carries its text and says whether that text is already marked up. A sender
//! that receives [`Markup::None`] is obliged to make it safe for its own syntax.

/// Whether a message's text already carries a channel's markup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Markup {
    /// Plain prose and untrusted data. **The sender must escape it.**
    None,
    /// Authored in Telegram's markdown, `*bold*` and all, and passed through untouched.
    ///
    /// The migration marker: every message still carrying this is one a second channel can only
    /// render as Telegram text. The digest is the big one — it is a few hundred lines of string
    /// building that wants breaking into fields before Discord can show it as an embed.
    Telegram,
}

/// One thing you can tap under a message.
///
/// `data` is what comes back when it is tapped, and **Telegram caps it at 64 bytes** — which is why
/// the decision inbox sends a row id and an option *index* rather than the answer's text. A longer
/// value is silently rejected by the API, so the cap is a real constraint rather than a guideline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub label: String,
    pub data: String,
}

/// One message, independent of who delivers it.
///
/// `buttons` is a Telegram capability and every other transport ignores it. That is the honest
/// degradation rather than a gap: a message carrying buttons also spells its options out in the
/// text, so a Discord reader sees what the choices are and answers somewhere else. A webhook has no
/// way to send a tap back at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    text: String,
    markup: Markup,
    buttons: Vec<Button>,
}

impl Message {
    /// Text that has no markup and may contain anything — including characters that would
    /// otherwise break the transport.
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            markup: Markup::None,
            buttons: Vec::new(),
        }
    }

    /// Text already written in Telegram's markdown. Passed through as-is.
    ///
    /// Use only where the emphasis is deliberate and the content is ours — never for a pool name,
    /// a token symbol, or anything else that arrived from a chain.
    pub fn telegram_markup(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            markup: Markup::Telegram,
            buttons: Vec::new(),
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn markup(&self) -> Markup {
        self.markup
    }

    /// Attach taps. Ignored by every transport but Telegram.
    pub fn with_buttons(mut self, buttons: Vec<Button>) -> Self {
        self.buttons = buttons;
        self
    }

    pub fn buttons(&self) -> &[Button] {
        &self.buttons
    }

    /// Whether the sender has to make this safe before sending it.
    pub fn needs_escaping(&self) -> bool {
        self.markup == Markup::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_the_senders_problem() {
        let message = Message::plain("WETH/USDC* out of range");
        assert!(message.needs_escaping());
        assert_eq!(
            message.text(),
            "WETH/USDC* out of range",
            "the message keeps what it was given — escaping happens at the transport, so one \
             author cannot half-escape for a channel it does not know about"
        );
    }

    #[test]
    fn authored_markup_is_passed_through() {
        let message = Message::telegram_markup("*Net worth* $1");
        assert!(!message.needs_escaping());
        assert_eq!(message.markup(), Markup::Telegram);
    }
}
