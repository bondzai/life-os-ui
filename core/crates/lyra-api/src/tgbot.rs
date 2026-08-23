//! The Telegram command bot — port of `wallet-portfolio/tgbot.py`.
//!
//! `lyra-alerts` **pushes** alerts and the daily brief out. This **pulls** commands in, by long
//! polling `getUpdates`. Polling rather than a webhook on purpose: a webhook needs a public HTTPS
//! endpoint, and the whole point of this box is that it sits behind a home router with nothing
//! forwarded to it.
//!
//! # Only the owner is answered
//!
//! Every update is checked against the pinned `TELEGRAM_CHAT_ID` before anything runs. A bot token
//! is a URL anyone who has it can message; the chat id is what makes this *yours*. A message from
//! anywhere else is counted and dropped — never answered, and never echoed back, so a stranger
//! cannot use the bot as a mirror to put text in front of the owner.
//!
//! # Restart-safe
//!
//! The update offset is acknowledged **after** the reply is sent and persisted in `alert_state`,
//! so a restart mid-command re-runs at most that one command rather than replaying the backlog.

use std::sync::Arc;
use std::time::Duration;

use lyra_alerts::state::AlertStore;
use lyra_alerts::telegram::{MessageSender, TelegramSender};
use serde_json::{Value, json};

use crate::AppState;
use crate::wealth;

/// The Bot API root. A constant so the token is only ever interpolated in one place.
const API_BASE: &str = "https://api.telegram.org";

/// How long Telegram holds a `getUpdates` request open with nothing to say.
const LONG_POLL_SECS: u64 = 25;

/// Where the acknowledged offset lives, so a restart does not replay the backlog.
const OFFSET_KEY: &str = "tgbot:offset";

/// A ceiling on how many commands one poll may run.
///
/// After an outage Telegram hands back everything queued at once. Without this, coming back from
/// a week offline would fire a week of portfolio reads back to back.
const MAX_PER_POLL: usize = 5;

/// The command surface, in the order `/help` lists it.
const COMMANDS: &[(&str, &str)] = &[
    ("nw", "Net worth + 24h"),
    ("tiers", "Allocation split"),
    ("positions", "LP positions & range"),
    ("rewards", "Claimable rewards"),
    ("risk", "Borrow health"),
    ("sats", "Bitcoin stack"),
    ("bots", "KuCoin bots"),
    ("market", "Valuation & mood models"),
    ("digest", "The full daily brief"),
    ("status", "Sweep & bot status"),
    ("help", "This list"),
];

/// Start the bot, if it is configured. A no-op otherwise — the ordinary "Telegram isn't set up"
/// state, not a failure.
pub fn spawn(state: AppState) {
    let sender = Arc::new(TelegramSender::from_env(&lyra_alerts::config::ProcessEnv));
    if !sender.can_send() {
        tracing::info!("telegram command bot idle: no bot token or chat id");
        return;
    }
    let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") else {
        return;
    };
    let Ok(owner) = std::env::var("TELEGRAM_CHAT_ID") else {
        return;
    };

    tokio::spawn(async move {
        tracing::info!("telegram command bot listening");
        run(state, sender, token.trim().to_string(), owner.trim().to_string()).await;
    });
}

async fn run(state: AppState, sender: Arc<TelegramSender>, token: String, owner: String) {
    let Ok(client) = reqwest::Client::builder()
        // Comfortably longer than the long poll itself, or every idle poll would look like a
        // timeout and the loop would spin.
        .timeout(Duration::from_secs(LONG_POLL_SECS + 10))
        .build()
    else {
        tracing::error!("telegram command bot: could not build an HTTP client");
        return;
    };

    // Publish the command list so Telegram's "/" menu offers them. Without this the bot looks
    // inert even when it is listening: nothing autocompletes, so there is no way to discover that
    // it answers anything at all.
    publish_commands(&client, &token).await;

    let store = AlertStore::new(&state.pool);
    let mut offset = store
        .get_json(OFFSET_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    loop {
        let updates = match poll(&client, &token, offset).await {
            Ok(updates) => updates,
            Err(e) => {
                // A network blip must not end the bot for the life of the process.
                tracing::warn!(error = %e, "telegram getUpdates failed; retrying");
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };

        for update in updates.into_iter().take(MAX_PER_POLL) {
            let update_id = update.get("update_id").and_then(Value::as_i64).unwrap_or(0);
            if let Some((chat, text)) = message_of(&update) {
                if chat == owner {
                    let command = command_of(&text.to_lowercase()).to_string();
                    let reply = handle(&state, &text).await;
                    let delivered = sender.send(&reply).await;
                    // Logged because "the bot does nothing" and "the bot answered and the reply
                    // never arrived" look identical from the outside, and only one of them is a
                    // problem with this process.
                    tracing::info!(%command, delivered = delivered.is_sent(), "answered a command");
                } else {
                    // Counted, not answered. Replying would confirm the bot exists to whoever
                    // found the token, and echoing their text would put it in front of the owner.
                    //
                    // The id *is* logged: the commonest way this goes wrong is a correct bot with
                    // TELEGRAM_CHAT_ID pointing at a different chat, and without the id there is
                    // no way to tell that apart from a stranger probing the token.
                    tracing::warn!(from = %chat, "telegram command from an unpinned chat; ignored");
                }
            }
            // Acknowledged only after the reply went out.
            offset = update_id + 1;
            let now = wealth::now_secs();
            if let Err(e) = store.put_json(OFFSET_KEY, &json!(offset), now).await {
                tracing::warn!(error = %e, "could not persist the telegram offset");
            }
        }
    }
}

/// Hand Telegram the command list behind the "/" menu. Best effort — a failure here costs
/// discoverability, not function, so it is logged and the bot carries on.
async fn publish_commands(client: &reqwest::Client, token: &str) {
    let commands: Vec<Value> = COMMANDS
        .iter()
        .map(|(command, description)| json!({ "command": command, "description": description }))
        .collect();
    let result = client
        .post(format!("{API_BASE}/bot{token}/setMyCommands"))
        .json(&json!({ "commands": commands }))
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {
            tracing::info!(count = COMMANDS.len(), "published the telegram command menu");
        }
        Ok(response) => tracing::warn!(status = %response.status(), "setMyCommands refused"),
        Err(e) => tracing::warn!(error = %e.without_url(), "could not publish the telegram command menu"),
    }
}

/// A `reqwest` error, said usefully and without the token.
///
/// Its `Display` is one line — "error sending request" — which reads the same for a DNS failure,
/// a TLS handshake and a timeout. The cause chain is what distinguishes them, and the URL, which
/// carries the bot token, is dropped first.
fn describe(e: reqwest::Error) -> anyhow::Error {
    let mut detail = String::new();
    let mut source: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(cause) = source {
        detail.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    let kind = if e.is_timeout() {
        " (timeout)"
    } else if e.is_connect() {
        " (connect)"
    } else {
        ""
    };
    anyhow::anyhow!("{}{kind}{detail}", e.without_url())
}

/// The `getUpdates` URL.
///
/// Built here rather than inline so it can be asserted on. A `\`-continuation in the literal once
/// left nine spaces in the path — `getUpdates%20%20%20…?timeout=` — and every poll failed for a
/// day while messages queued unread, because a malformed URL fails exactly the way a network
/// outage does. Nothing in the log said "bad URL"; it said "error sending request".
fn updates_url(token: &str, offset: i64) -> String {
    format!(
        "{API_BASE}/bot{token}/getUpdates?timeout={LONG_POLL_SECS}&offset={offset}&allowed_updates=%5B%22message%22%5D"
    )
}

async fn poll(client: &reqwest::Client, token: &str, offset: i64) -> anyhow::Result<Vec<Value>> {
    // Only messages: nothing here acts on edits, channel posts or inline queries, and asking for
    // them would mean paging through updates that can never be handled.
    let url = updates_url(token, offset);
    let body = client
        .get(url)
        .send()
        .await
        // `reqwest::Error` renders the URL it failed on, and that URL carries the bot token —
        // which would write the secret into the log on every transient network blip.
        .map_err(describe)?
        .json::<Value>()
        .await
        .map_err(describe)?;

    Ok(body
        .get("result")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// `(chat id, text)` for an update this bot can act on.
fn message_of(update: &Value) -> Option<(String, String)> {
    let message = update.get("message")?;
    let chat = message.get("chat")?.get("id")?;
    // The id is a number in the payload and a string in the environment.
    let chat = chat
        .as_i64()
        .map(|n| n.to_string())
        .or_else(|| chat.as_str().map(str::to_string))?;
    let text = message.get("text")?.as_str()?.trim().to_string();
    (!text.is_empty()).then_some((chat, text))
}

/// The command word, lowercased and stripped of Telegram's `/cmd@botname` suffix.
fn command_of(text: &str) -> &str {
    let word = text.split_whitespace().next().unwrap_or("");
    let word = word.strip_prefix('/').unwrap_or(word);
    word.split('@').next().unwrap_or(word)
}

fn help() -> String {
    let mut out = String::from("Lyra — what I can tell you\n\n");
    for (name, description) in COMMANDS {
        out.push_str(&format!("/{name} — {description}\n"));
    }
    out
}

async fn handle(state: &AppState, text: &str) -> String {
    match command_of(&text.to_lowercase()) {
        "start" | "help" | "menu" => help(),
        "status" => wealth::bot_status_line(state).await,
        "market" => wealth::bot_market_line().await,
        other => match wealth::bot_book_line(state, other).await {
            Some(line) => line,
            None => format!("I don't know /{other}.\n\n{}", help()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_word_survives_arguments_and_the_at_suffix() {
        assert_eq!(command_of("/nw"), "nw");
        assert_eq!(command_of("/nw@lyra_bot"), "nw");
        assert_eq!(command_of("/note buy more sats"), "note");
        // Case is the caller's job — `handle` lowercases before dispatching — so this returns
        // the word as typed rather than pretending to normalise it.
        assert_eq!(command_of("NW"), "NW");
        // Bare words work too: a phone keyboard drops the slash more often than you would think.
        assert_eq!(command_of("help"), "help");
    }

    #[test]
    fn an_update_without_text_is_not_a_command() {
        // A photo, a sticker, a join event: all have a message and no `text`.
        assert!(message_of(&json!({"update_id": 1, "message": {"chat": {"id": 42}}})).is_none());
        assert!(message_of(&json!({"update_id": 1})).is_none());
        assert!(
            message_of(&json!({"update_id": 1, "message": {"chat": {"id": 42}, "text": "   "}}))
                .is_none()
        );
    }

    /// The chat id is a number on the wire and a string in the environment; comparing them
    /// without normalising would reject the owner and answer nobody.
    #[test]
    fn the_chat_id_is_read_as_a_string_whichever_way_it_arrives() {
        let numeric = json!({"update_id": 7, "message": {"chat": {"id": 12345}, "text": "/nw"}});
        assert_eq!(
            message_of(&numeric),
            Some(("12345".to_string(), "/nw".to_string()))
        );
        let stringly = json!({"update_id": 7, "message": {"chat": {"id": "12345"}, "text": "/nw"}});
        assert_eq!(
            message_of(&stringly),
            Some(("12345".to_string(), "/nw".to_string()))
        );
    }

    /// The bug this file shipped with: a line-continuation left literal spaces in the path, so
    /// every poll failed and looked like a network problem.
    #[test]
    fn the_updates_url_is_well_formed() {
        let url = updates_url("123:ABC", 42);
        assert_eq!(
            url,
            "https://api.telegram.org/bot123:ABC/getUpdates\
             ?timeout=25&offset=42&allowed_updates=%5B%22message%22%5D"
                .replace(' ', "")
        );
        assert!(!url.contains(' '), "a space in the path breaks every poll: {url}");
        // The query has to start immediately after the method name.
        assert!(url.contains("/getUpdates?timeout="), "{url}");
    }

    #[test]
    fn help_lists_every_command() {
        let text = help();
        for (name, _) in COMMANDS {
            assert!(text.contains(&format!("/{name}")), "{name} missing from /help");
        }
    }
}
