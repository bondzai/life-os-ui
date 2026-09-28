# Systems and decisions

Lyra as **chief of staff**: it reads what your other systems need decided, asks you, and carries the
answer back. Configured from **Settings → Systems**; the questions turn up at the top of **Today**.

Tables are `systems` and `decisions` (migration v10). The poll is a step on the alert sweep's
thirty-second tick; the answer travels back as a `system.answer` job.

## Lyra is a courier

The origin system owns the decision, knows what it means, and acts on it. Lyra carries the question
to a phone and the answer back. Everything below follows from that, and so does the thing Lyra
deliberately **cannot** do: there is no path in this code that acts on another system except to
deliver an answer you gave.

`SCOPES` is `["read", "propose"]` and `act` is not on it. Scopes are stored as a list from the start
so tightening them later is data rather than a migration.

## The client is in `lyra-api`, never in `lyra-mcp`

`lyra-mcp`'s guarantee is that **no tool body can cause an effect** — there is no signing path to
reach, and two tests hold the capability ladder shut (`docs/mcp.md` §1). A client that can call
another system's *tools* is an effect path by definition, so putting one in that crate would quietly
turn the read-only desk into a lever on the whole house while every existing test still passed.

It lives in the binary that already has write paths, a queue and an audit trail. **Do not move it.**

## One trait, two speakers

`systems::Adapter` is the contract: health, what is new, take an answer. Two implementations today.

- **`HttpAdapter`** — the versioned REST door. Redirects are refused (`redirect::Policy::none()`)
  for the same reason a Discord webhook refuses them: a bearer token travels on the request, and a
  302 decides after the fact which host receives it. Five-second timeout.
- **`FixtureAdapter`** — a `fixture:///path/to/file.json` address reads that file instead. It parses
  **the same struct** the HTTP adapter does, so a stub that works is evidence the wire shape is
  right (`the_fixture_and_the_wire_are_one_shape`). A stub is a visible choice in the registry, not
  a hidden environment variable: the row on screen says `stub`.

An MCP adapter is a third implementation behind the same trait. Worth building when a **second** real
system makes discovery pay for itself — with one system it is a cost, and Lyra's own MCP server is
hand-written JSON-RPC with no SDK behind it, so a client is new machinery either way.

## What a system has to expose

```
GET  /healthz                      → 2xx
GET  /decisions?since=<cursor>     → { "cursor": "...", "decisions": [ … ] }
POST /decisions/<id>/answer        → 2xx      { "answer": "castles", "decided_at": 1759… }
```

One decision on the wire. Only `id`, `question` and `options` are required — a system with nothing
to add should not have to send nulls to be understood:

```json
{
  "id": "dec-7",
  "question": "Medieval week 1: castles or alliances?",
  "detail": "next week's order",
  "options": [{ "value": "castles", "label": "Castles" }],
  "evidence": "castles tested 9% better in the Ancient finale",
  "raised_at": 1759000000,
  "expires_at": null
}
```

`evidence` is not decoration. A one-tap answer without the reason for it is a coin flip with extra
steps, so it is shown next to the buttons.

**The answer endpoint must be idempotent on the decision id.** Lyra retries, and a confirmation lost
after the origin accepted it means the same answer arrives twice.

## Polling, not receiving

Lyra asks; systems do not push. The tick already exists and a decision that waits thirty seconds is
not late, whereas receiving means an authenticated inbound endpoint and a port on the home network.
This is **not** the same reason the deploy pulls — that is about the repository being public — it is
simply the cheaper half of an even trade. Revisit it when something needs to be sub-second, which a
human decision never is.

One system that is down does not stop the others being polled, and never takes the sweep with it:
the error lands on that system's row and the screen shows it.

Two orderings inside the poll are load-bearing:

- **The cursor moves only after the rows are committed.** The other order loses a window on a crash:
  marked read, never written down.
- **A health check never moves the cursor.** It read nothing; advancing would skip whatever was in
  the window.

Moving a system's address clears its cursor, because a position means nothing against a different
host.

## A question is asked once

`decisions` is unique on `(system_id, external_id)`, and `raise` is `ON CONFLICT DO NOTHING`.
Re-reading a window — a cursor that did not advance, a restart mid-sweep — is the normal case, not
an error.

**Do nothing, not upsert.** An update would let the origin rewrite a question you have already been
asked, and in the worst case change what you were agreeing to between the notification and the tap.

An expiry that has passed is **shown, not dropped**. "You missed this" is information; a clean
inbox while a factory waits is the failure mode.

## The answer is committed before it is delivered

This is the rule the whole feature turns on. A tap that reached Lyra and then vanished because the
origin was unreachable is the failure that would make the idea untrustworthy — worse than never
asking.

So `answer` and `delivered_at` are separate columns. Answered-but-not-delivered is a real state:

1. You tap. The row is written. The API responds.
2. A `system.answer` job is enqueued, keyed `answer:<decision id>`.
3. The tick's sweep enqueues one for anything still owed. Same key, so the belt and the braces are
   one job.
4. It retries with the queue's backoff, and if it finally gives up the dead-letter reporter says so
   — on the same phone (`docs/jobs.md` §5).

**The first answer wins.** `WHERE answered_at IS NULL` makes a second tap — the button pressed
twice, a callback delivered twice — a no-op rather than a different instruction sent after the first
one was already on its way. The response carries the *stored* answer, so the screen says what Lyra
will actually deliver rather than what the request asked for.

An answer must be one of the values the origin offered. Free text is refused by name rather than
passed along: inventing a value produces a decision the origin cannot honour, which fails later,
somewhere else, long after the tap that caused it.

## The token

Sealed with `LYRA_SECRET_KEY` and the row id as AAD, exactly as a Discord webhook is — so a token
cannot be lifted from one system's row into another's, and `SystemStore::token_of` is the one door.
The screen gets a preview and never the value, which is why absence on a `PATCH` means "leave it
alone". See `docs/notifications.md` § The credential for what that protects and what it does not.

A system with **no** token is allowed: a service on the same host behind Tailscale may not want one,
and the row says so plainly rather than looking configured.

## Answering from your phone

A raised decision is announced to the `day` group at `info` severity, keyed by the decision so it is
sent once however many times something notices it. On Telegram it arrives with a button per option;
everywhere else it arrives as text.

**The options are spelled out in the message as well as attached as buttons.** Every channel but
Telegram ignores an inline keyboard, so without the words a Discord reader gets a question with no
visible choices.

**A tap carries the decision id and the option's index**, never the answer's text: Telegram caps
`callback_data` at 64 bytes and an id already spends 36 of them. An answer like "hold until the Q3
numbers land" would not fit, and the API rejects the send rather than truncating.

**`answerCallbackQuery` is always called**, whatever the outcome. An unanswered callback leaves the
button spinning on the phone until Telegram times it out, which reads as a broken bot even when the
answer was recorded perfectly.

The tap goes through the same `DecisionStore::answer` the web inbox uses, so the two cannot disagree
about what "answered" means — including that the first one wins. Tapping a second time replies
"Already answered: Castles" rather than sending a different instruction.

One thing worth knowing about the fallback: while routing is empty **everything** falls back to
`deliver.telegram`, and that path carries the buttons too. It did not at first, which meant the one
box that most needed them — a fresh one, with nothing configured — got the inbox as flat text.

## What is not built

- **A Discord tap is not possible as things stand.** A webhook is outbound-only — it has no
  interaction callback. Real buttons need a Discord *application* with a gateway connection, which
  is its own decision. Discord tells you; Telegram asks you.
- **The message is not edited after a tap.** The buttons stay on screen and a second tap says
  "already answered" rather than the keyboard disappearing. `editMessageReplyMarkup` is the fix and
  it needs the message id kept somewhere.
- **The brief does not mention decisions yet.** Deliberate: it goes cross-system once there is a
  second real source.
