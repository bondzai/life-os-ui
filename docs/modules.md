# Modules

A module is a sidebar entry: an entity type or two, a route, and a page. The entity system,
repositories and hooks do the data work, so adding one is mostly configuration.

> **`src/core/config/modules.ts` is the authoritative registry.** It is 37 lines of TypeScript
> carrying better doc comments than this file can, including *why* the groups are Now / Plan /
> Money. A table hand-synced against a literal is a drift machine — this document explains the
> shape and the decisions, and points at the source for the list.
>
> **Rewritten 2026-09-21.** The previous version tabulated nineteen modules, nine of which 404 —
> it described the 17-module app that the Lean release (v2.5.0) deleted. If anything below reads
> as describing a page you cannot reach, the source is right and this is wrong.

---

## 1. Grouped by rhythm, not by category

The sidebar asks three questions rather than sorting into subjects:

| Group | Question | Modules |
|---|---|---|
| **Now** | What am I doing right now? | Focus, Deep Work, Inbox |
| **Plan** | What am I working towards? | Tasks, Projects, Goals, Calendar, Habits, Notes, Review, Dashboard |
| **Money** | Where is the money? | Wealth (eight sub-routes) |

It used to be Daily (2) and Plan (9). A heading over nine of eleven entries sorts nothing, and a
heading that sorts nothing stops being read.

Inbox and Deep Work are listed because they are real routes that were reachable only through a
link buried in a Focus panel and a `⌘⇧D` shortcut — **a route nothing points at is a feature you
have to remember you own.**

Knowledge left the sidebar for Settings and kept its route. It configures the AI's persona, agents
and context, which is configuration rather than a plan; filed under Plan next to Notes it read as
somewhere you had put something.

**Every module has a `g`-key.** `g t` for Tasks, `g p` for Projects, the way Linear and GitHub do
it, shown on hover beside each item so it teaches itself on the way past. The key lives on the
module rather than in a table of its own, and `goKeyIndex` throws at import on a duplicate — a
collision is a module you can never reach by keyboard, and it fails silently otherwise.

## 2. Projects — a type again, since 2026-09-20

`fd2948e` merged Project into Goal in March, on the grounds that two hierarchies were one too many.
That was right for a goal tree and wrong for a body of work: a Shorts channel or a freelance
contract is not an outcome you want, it is a thing with a repo, a client and a publishing schedule.

The reversal cost no migration and no new table, because the live database held **zero** project
entities — the merge was complete, so this reverses it cleanly rather than untangling data. A
project is an entity with `type: 'project'`, which the API has always accepted, and the optional
half — client, repo, stack — lives in `metadata`, unset on the projects that do not need it.

Three decisions worth keeping:

- **Tasks belong to a project through `metadata.projectId`**, the convention already read by
  `use-velocity`, `detect-stale-projects`, `detect-velocity`, the morning brief and the AI context
  builders. Setting that one field is what makes the velocity panel work here with no new code.
  One field, not two, because ids are unique across types — so a stored id is unambiguous without
  recording which kind it points at, and a task pointing at a goal simply never matches a project.
  Two fields would mean rewriting every existing row to guess which of the two an old id meant.
  The cost is that a task belongs to one thing rather than to a project *and* a goal at once.
- **Progress is derived from task counts**, never stored. A number you have to remember to update
  is a number that lies, and no tasks shows no bar rather than a confident 0%.
- **Which project is open lives in the URL**, not in state. Goals copies the id into state inside
  an effect, which needs the list loaded first, leaves the back button doing nothing, and trips
  `react-hooks/purity`. Deriving it needs no effect and gives a detail view you can link someone to.

Deleting a project says what happens to its tasks: the API hard-deletes with no cascade, so they
stay put and lose their project. A dangling id reads as *"Unknown (deleted)"* rather than as
unassigned, because those are different facts. That is the safer default, but only if the person
clicking knows it.

The task panel's project picker offers projects **and** goals, grouped, and drops archived entries
— assigning fresh work to a dropped project is almost always a misclick, while a task already
pointing at one keeps its link.

## 3. Wealth — eight sub-routes

| Route | What it answers |
|---|---|
| `/wealth` (Overview) | Net worth, tiers, the snowball panel with its picker and projection |
| `/wealth/holdings` | Every token position, one row per token |
| `/wealth/defi` | The LP and lending book — see below |
| `/wealth/opportunities` | vfat's whole pool universe, filtered server-side |
| `/wealth/btc` | The Bitcoin stack |
| `/wealth/bots` | KuCoin spot rebalance and futures bots |
| `/wealth/journal` | Saved analyses, including everything `save_analysis` writes over MCP |
| `/wealth/settings`, `/wealth/alerts` | Wallets and currency; thresholds and channels |

### The DeFi page rewrite — September 2026

`/wealth/defi` was five stat cards over a table. It is now **one bar and one ledger**, and the whole
book fits on one screen. The sequence of decisions is worth recording because each one is a rule
the rest of the wealth surface now follows.

- **One primary figure, four set inline beside it.** Five cards gave five figures the same weight,
  so the eye had no entry point, and at `lg` they wrapped 3 + 2 — ragged on exactly the screen this
  is read on. Two levels of emphasis instead of one, at about a third of the height.
- **Out of range is a state, not a quantity, so it filters itself.** The number telling you to act
  is one click from acting. It stays plain text: the range badges on the rows are load-bearing, and
  a sixth badge up top would dilute them.
- **Borrowed, worst health factor and ready-to-harvest moved into the bar.** Borrowed reads the
  *whole* book rather than the filtered rows — liquidation does not care which chain you are
  looking at, and a risk figure that vanishes when you filter is worse than no figure. It shows the
  **worst** health factor, not an average, because an average cannot hurt you while one position
  under it is being liquidated; and it only takes colour below the same 1.5 threshold that gates
  the Telegram alert, because a risk number that is always red is decoration. It is absent entirely
  on a wallet that does not borrow.
- **Loans joined the LP table.** The one row on the page that can liquidate you was the one row you
  could not see. A loan is a position — a venue, a value, and a number saying how close it is to
  going wrong — which is the same three questions the LP rows answer in the same three columns. So
  Range became Health: an LP marker nearing the end of its band and a health factor nearing 1 are
  the same shape of warning, and they sit in the same place on the row. Columns a loan has no
  answer for say so with an em dash rather than a zero.
- **Value is the protocol-aware net**, which on Aave is the debt alone, because the collateral is
  already in the book as spot aTokens. A negative number beside a five-figure collateral balance
  reads as a bug, so the cell spells out why.
- **Badge the exception.** "In range" fired on the healthy majority and was the loudest thing in the
  row, repeating what the green marker already said and making the one row that needed attention
  harder to find. `null` keeps a neutral badge — a position whose range the server could not
  determine must never render as healthy — and "full range" keeps its own, because it is a
  different kind of position rather than a health state.
- **The structure renders on the first frame and only the cells arrive late.** A skeleton *instead
  of* the page means the first thing you see is discarded and everything moves when the data lands.
  A waiting figure draws a bar the size of its number: `$0.00` is a lie about someone's money, and
  `—` is this codebase's word for *"we looked and could not read it"* — neither is true while the
  request is in flight, so the placeholder says "coming". Error and empty still replace the page,
  because they are terminal rather than transitional, and both now wait for loading to finish so
  neither can flash during it.
- **Detail lives behind a click, and clickability is drawn, not implied.** The snowball, claimable
  by token and the full borrowing panel open from the figures they belong to. Both openers carry
  the same expand glyph on the label and the same accessible name — one rule, *"label has a mark"
  means "this one opens"* — because hover is undiscoverable and on a touch screen does not exist.
  Nothing to collect means nothing to open, and the figure stays plain.

Related rules that landed across the whole wealth module in the same stretch: chain and token names
come from `identity.ts` so every surface says "BNB" and "HyperEVM" rather than title-casing a slug
into "Bnb"; `marks.tsx` draws shape-encodes-kind marks on Holdings and Overview but **not** on the
dense DeFi table, where decoration competed with the figures; and win/loss colours were raised to
AA contrast.

## 4. Adding a module

1. Define the entity type in `src/core/types/entity.ts` if it needs a new one — most do not.
2. Add the config to `src/core/config/modules.ts`, including a free `goKey`.
3. Create the page in `src/pages/`.
4. Add the route in `src/app.tsx`.
5. Use `useEntities(type)` — the hook and repository already work.

No new tables, no new API endpoints, no new stores. `entities` is one table for every type, and
type-specific fields live in the `metadata` JSON blob. See
[`docs/core-engine.md`](./core-engine.md).
