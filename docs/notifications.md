# Notifications

Every message Lyra sends you belongs to a **group**, and a group is **routed** to channels. A channel
is one destination — a Discord room, a Telegram chat. That replaces the only policy the environment
could express, which was "everything configured receives everything".

Configured from **Settings → Notifications**. The tables are `channels` and `routes` (migration v8);
delivery is the `notify.deliver` job.

## The groups

| Group | Kinds | Why together |
|---|---|---|
| `money` | out-of-range, back-in-range, fees ready, health factor | Time-sensitive, about real positions |
| `day` | the daily brief, the habits nudge | Scheduled and expected. The only group where quiet hours are the point |
| `system` | reserved: dead letters, deploys, restarts | About the box rather than about you. **Nothing produces this yet** |

Groups are declared in `notify::GROUPS`, and the HTTP layer refuses a route to a group not on that
list rather than storing one nothing would ever deliver to.

## Severity

`info` / `warning` / `critical`. A route carries its level **and above**, so `warning+` on your phone
and `info+` in a Discord room is the usual arrangement.

`notify::severity_of` maps an alert to a level, and only **`HealthFactorLow` is critical** — because
critical is the only level that pierces quiet hours. Approaching liquidation is the one thing worth
waking for; a position leaving its range is not.

An unrecognised severity reads as `info` rather than being refused. Not delivering something because
its level was misspelled is worse than delivering it quietly.

## Quiet hours

Local hours on a route, and the range **wraps**: `22`–`7` is the evening and the small hours, which is
the only way anyone wants to write it. Local because "do not wake me" is a wall-clock idea. A route
with one bound set and not the other is treated as having none — half a range is a half-finished edit,
not an instruction.

## One job per channel

`notify::notify` resolves the destinations and queues **one `notify.deliver` job per channel**. Each
gets its own backoff, its own dead letter, and writes its own health onto the channel row.

That split is the fix for a real bug rather than a tidiness preference. `Channels::send` reports
success when **any** channel took the message, so a Telegram success used to mask a Discord failure
entirely — the job completed, and the only trace was a `tracing::warn`. With one job and one `"sent"`
effect there were only two options and both lost: drop the failure, or retry and re-send to the
channel that already succeeded. Separate jobs make the question go away.

`deliver.telegram` still exists and still covers every configured channel in one job, now with an
effect per channel so a retry only attempts the ones still owed it. It is the fallback path below.

## The fallback, and when to remove it

**If routing resolves to nothing, the message goes to every configured channel instead**, and the log
says so.

This is transitional and deliberate. The box was already sending real alerts about real money before
any of this existed, and it has no channels and no routes until somebody opens Settings. Routing
correctly to nowhere would have been a silent stop to every alert — the exact failure the feature was
built to remove.

The cost: **"I route nothing here on purpose" cannot yet be said.** It reads as "not configured".
That is the right trade while the tables are empty and the wrong one once they are not. Three tests
pin the behaviour so removing it is a decision rather than a regression — search for
`falls_back_rather_than_disappearing`.

## The credential

A Discord webhook URL *is* the credential: its last path segment is a token, and anyone holding the
URL can post to that room.

- **Sealed at rest.** AES-256-GCM, key from `LYRA_SECRET_KEY`, via `lyra_db::secrets`. Before this,
  no credential was in the database at all — which is exactly why the nightly `VACUUM INTO` backups
  could go offsite without a thought. Stored in the clear, fourteen nightly files and the offsite copy
  would each have become a live credential, silently. **Set the key or the UI refuses to store a
  webhook**, by name; it never falls back to plaintext.
- **The channel id is the AAD**, so a sealed secret cannot be copied between rows — unsealing under a
  different id fails rather than posting one room's message to another room's webhook.
- **Never returned.** A channel comes back with a preview — host, webhook id, last four characters —
  and `stored_secret`. The one door is `ChannelStore::secret_of`, named so the call site reads as what
  it is. Tests at both layers serialize every read path and fail if the token appears.
- **Write-only in the UI.** The field is always empty, because the screen was never given the value.
  Absence on a `PATCH` therefore means "leave it alone", which is the only way it can be said.

This protects a database copy leaving the box, not someone who has the box: the key is on the same
machine, in a file the service reads. Copies of the database leave routinely and by design; that is
the threat being addressed.

## Validating a URL

`Transport::check` owns the rules and asks `Webhook::new`, which refused every host but
`discord.com` — and plaintext, and the legacy `discordapp.com` — long before any of this was
configurable. **Making the URL editable is not the same as making it unconstrained.** A UI that
accepted any URL would have undone a guard this repo already had, with a test already explaining why:
the value is posted to verbatim, so an arbitrary host is a credential handed away.

Refusals name the rule rather than saying "invalid", because a pasted webhook is usually right and the
mistake is usually specific — the wrong domain, or `http` from an old note.

Two more things follow from the URL being input rather than something you typed into a file:

- **Redirects are refused** (`redirect::Policy::none()`). The host is checked once, at write time;
  without this the host finally posted to is wherever the redirect chain ends, and a home network is
  on the other side. *Not covered by a test* — that needs a server that redirects.
- **The check runs again at send time.** A row can outlive the rules that admitted it, and the send
  path is the code actually handing the credential over.

## The daily brief

The brief is built once and delivered per channel, and the rule that matters is unchanged: **the delta
baseline advances only once somebody has received it.** A brief nobody got must not consume the changes
it would have shown.

`build_digest` and `advance_digest_snapshot` are now separate, which reads like it weakens that rule
and does the opposite. The built text and the new baseline are recorded as a job step, so a retry an
hour later sends *the brief that was built at 08:00* rather than rebuilding it against a portfolio
that has since moved. The baseline advances when **at least one** channel has taken it — the old
meaning of "sent" — while the channels still owed it keep retrying on their own.

The on-demand `/api/wealth/alerts/digest` endpoint still uses the whole fan-out in one call, because a
button press wants an answer rather than a queue.

## Settings you need

| | |
|---|---|
| `LYRA_SECRET_KEY` | Seals stored credentials. `openssl rand -base64 32`. Without it the UI refuses to store a webhook |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram's credential stays in the environment — a bot token is stronger than a room webhook and there is only one of it |
| `DISCORD_WEBHOOK_URL` | Still read, still the fallback channel. A UI-configured room does not need it |

## What is not built

- **Nothing produces `system`.** A dead-lettered job should say so, and that is the obvious next
  producer — it is also the group that most wants a channel you can ignore until you care.
- **No in-app notifications.** The frontend `notification-store` is local-only: zustand and
  localStorage, nothing fetches it from the server. An inbox is a store rather than a transport, so it
  is not a `MessageSender` and not a channel.
- **No `notifications` table.** The job row is the history, which the queue already retains for
  fourteen days. A table earns its place when something wants to read notifications back — an in-app
  inbox, or a "what did you send me last week".
- **A generic webhook transport.** Adding a *named* service (ntfy, Slack, Home Assistant) is one
  `MessageSender` and one host check. A literal "post to any URL I type" needs an allowlist, because
  otherwise a settings form is an SSRF console pointed at a home network.
- **Telegram is not seeded as a channel row.** It works through the fallback. Adding it in Settings
  makes it routable.
