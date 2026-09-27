# Alerts — rules, digests, and the two channels

`lyra-alerts` is the outbound half of Lyra's messaging: it decides what is worth saying, and it
says it to every channel configured. It runs in-process inside `lyra-api`, so its upstream caches
are shared with the request path and an alert can never disagree with the page it points at.

This was the most under-documented shipped code in the repo until 2026-09-21. Discord has existed
since `2d79b7f` and appeared in no document at all.

---

## 1. Alert on the edge, not on the level

Every function in `rules.rs` is **pure**: current readings plus previous state in, alerts and new
state out. No clock, no network, no database. That is what makes latches, hysteresis and
once-a-day timing testable without sleeping or stubbing a socket.

A position that is out of range does not ping every fifteen minutes — it pings when it *goes* out.
Which means every rule needs memory, and memory that survives a restart, or a container redeploy
replays every alert you already acknowledged. State lives in the `alert_state` table.

Two hysteresis bands stop a value hovering on a threshold from flapping:

- fees re-arm only after dropping below **half** the threshold (`FEE_RESET_RATIO = 0.5`) — after an
  actual claim, not after a penny of accrual noise;
- a health-factor warning clears only **10% above** the floor (`HF_CLEAR_RATIO = 1.1`), so a
  position wobbling on the line is reported once rather than hourly.

**The first sweep is silent; the second is not.** A fresh `alert_state` baselines without sending.
Once it has a baseline, a real change sends a real message to a real phone. When testing, either
stop the API inside `ALERT_INTERVAL` or leave the channels unset.

## 2. A message before it has a channel

`Message` carries text plus a `Markup` tag, and the tag exists to fix a real bug rather than to
look tidy.

Bot replies are built from on-chain data — pool names, token symbols — and went out with
`parse_mode: Markdown` set. One `*` in a pool name and Telegram rejects the whole request with
`can't parse entities`, so the reply is **silently never delivered**; it surfaces only as
`delivered = false` in a log line. The builders' own comment said "plain text — no Markdown", and
it was right. The transport had no way to know.

| Constructor | Meaning |
|---|---|
| `Message::plain` | Prose and untrusted data. **The sender must make it safe for its own syntax.** |
| `Message::telegram_markup` | Authored in Telegram's markdown, passed through untouched |

`Markup::Telegram` doubles as the migration marker: every message still carrying it is one a second
channel can only render as Telegram-flavoured text. The digest is the big one — a few hundred lines
of string building that wants breaking into fields before Discord can show it as an embed.

**Telegram escaping strips rather than backslash-escapes.** Removal cannot produce an unbalanced
entity, and a dropped `*` costs a glyph where a rejected message costs the whole alert. Discord is
kinder — it renders unbalanced markup instead of rejecting the message — so there the text is
escaped and a pool name keeps every character it started with.

**Two markdowns that look alike are the trap worth a translator.** Telegram's legacy mode reads
`*bold*` and `_italic_`; Discord reads `**bold**` and `*italic*`. Passing one to the other unchanged
emphasises every digest heading the wrong way — quietly, and visible only by comparing both
channels side by side. `telegram_to_discord` is deliberately conservative: an unpaired marker is
left alone, and emphasis never spans a line.

## 3. Delivered means delivered *somewhere*

`Channels::from_env` reads every channel and keeps only the configured ones, so `can_send` is a
question about the list's length rather than a poll of its members. `Channels::send` fans out
**sequentially** — there are two of them, each already has a 12s timeout, and parallel fan-out
would need the senders behind an `Arc` for no gain anyone could measure.

It reports success when **any** channel took the message. That is the whole point of having two: an
alert that reached your phone has done its job, and failing the sweep because Discord was down
would turn redundancy into a new way to lose an alert. A channel that fails is logged by name, so
an outage stays visible without masking a delivery that worked.

The inverse matters as much: when *nothing* is configured the result is `Delivery::NotConfigured`,
never a failure. A box with no channels is the ordinary state of a fresh install, not a fault.

### One known wart, documented rather than papered over

`/api/wealth/alerts` still reports `can_send` **for Telegram alone**, so a Discord-only box
delivers alerts while the settings page says it cannot. That field is parity-gated and widening it
would fail the diff. The honest fix is a new ungated route reporting the channel names — the same
move `vfat-status` made. Until then, the discrepancy is real and this paragraph is where it lives.

## 4. The webhook URL *is* the credential

A Discord webhook URL ends in a token: anyone holding the whole URL can post to that channel. So it
gets the same containment as the Telegram bot token, mirroring `telegram.rs` deliberately rather
than inventing a second style.

- `Webhook` has a hand-written `Debug` that prints `[redacted]`, and no `Display`, no `Serialize`,
  no public accessor for the URL.
- The token is a **path segment**, so an HTTP error quoting its URL would publish it. Errors go
  through `SendError` after `without_url()`, then are scrubbed. `SendError`'s constructor requires
  being handed a scrubber, so an unscrubbed message cannot be constructed at all.
- **The host is checked on construction.** A "which host do we post to" setting is a
  credential-exfiltration switch, so a URL that is not Discord's is refused outright. `http://` is
  refused too.

Bodies past Discord's 4096-character embed limit are cut with a visible mark, because a brief that
arrives shortened beats one that does not arrive. Telegram's own 4096 limit is handled differently
and better: `split_for_telegram` splits an over-long message on blank lines, then newlines, then
characters, so a long brief arrives as several messages rather than being truncated or refused. See
[`docs/telegram.md` §6](./telegram.md).

### Why an embed rather than plain text

Plain text is what Telegram is for, and it renders a digest as a wall. Discord's value is that a
message can carry structure: a coloured stripe, a title, and up to 6000 characters across 25
fields. Today it sends one embed with a description, and leaves fields for when `Message` itself
carries them.

## 5. Configuration

| Variable | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | The Telegram channel. Unset, the sweep still runs and records state without sending — the right first-boot state |
| `DISCORD_WEBHOOK_URL` | The Discord channel. The full webhook URL, token and all. **This is a credential — back it up with `.env.local` and treat a leak as a channel takeover.** The host is validated, so a typo fails at construction rather than posting your portfolio somewhere else |
| `ALERT_INTERVAL` | Seconds between sweeps, default 900 |
| `DIGEST_HOUR` | Local hour for the daily brief. **Unset means no digest is ever sent** |
| `ALERT_FEE_USD` / `ALERT_HF` / `ALERT_REPORT_CCY` | The thresholds and the reporting currency |

Setting either channel turns on live delivery to a live phone or channel. See
[Deployment §7.1](./deployment.md).

## 6. What the queue changes

Today a failed alert send is logged and lost — `alert_loop` swallows the error, and the digest's
day key is only written on success, so a Telegram outage at digest hour costs the day's brief
silently. Stage D of [the assistant roadmap](./assistant-roadmap.md) turns delivery into a
`deliver.telegram` job with real backoff, which for a health-factor warning is the difference
between an alarm and a log line.

## See also

- [`docs/telegram.md`](./telegram.md) — the inbound half
- [`docs/api-server.md`](./api-server.md) — where the sweep runs
- [`docs/parity.md`](./parity.md) — why `alerts/test` and `alerts/digest` are excluded from the gate
  (a GET on either sends a real message)
