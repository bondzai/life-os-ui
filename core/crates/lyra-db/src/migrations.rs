//! Forward-only schema migrations, tracked by `PRAGMA user_version`.
//!
//! The convention is inherited from `wallet-portfolio/db.py` and argued for in its `DB_DESIGN.md`:
//! `MIGRATIONS[i]` takes the database from `user_version = i` to `i + 1`. **Never edit or reorder a
//! shipped entry — only append.** There are no down-migrations; restore from a backup instead.
//!
//! This chain starts fresh rather than replaying the two legacy chains, because `lyra.db` is a new
//! database that legacy rows are *imported* into (see [`crate::import`]).

use anyhow::{Context, Result};
use sqlx::{AssertSqlSafe, SqlitePool};

pub const MIGRATIONS: &[&[&str]] = &[
    // v0 -> v1: Lyra core. Column names are camelCase to match the Drizzle schema they replace
    // (`api/src/db/schema.ts`) — renaming them would be a breaking API change for no gain.
    &[
        r#"CREATE TABLE IF NOT EXISTS users (
               id        TEXT PRIMARY KEY,
               name      TEXT,
               role      TEXT,
               pin       TEXT,           -- bcrypt hash; the algorithm is NOT negotiable, see docs
               avatarUrl TEXT
           )"#,
        r#"CREATE TABLE IF NOT EXISTS entities (
               id          TEXT PRIMARY KEY,
               type        TEXT,
               title       TEXT,
               description TEXT,
               status      TEXT DEFAULT 'todo',
               priority    TEXT DEFAULT 'medium',
               tags        TEXT,          -- JSON array
               metadata    TEXT,          -- JSON object
               parentId    TEXT,
               ownerId     TEXT,
               visibility  TEXT DEFAULT 'private',
               dueDate     TEXT,
               createdAt   TEXT,
               updatedAt   TEXT
           )"#,
        r#"CREATE TABLE IF NOT EXISTS trackers (
               id        TEXT PRIMARY KEY,
               entityId  TEXT,
               value     REAL,
               unit      TEXT,
               note      TEXT,
               timestamp TEXT,
               ownerId   TEXT
           )"#,
        r#"CREATE TABLE IF NOT EXISTS schedules (
               id            TEXT PRIMARY KEY,
               entityId      TEXT,
               recurrence    TEXT,
               nextDue       TEXT,
               lastCompleted TEXT,
               isActive      INTEGER DEFAULT 1
           )"#,
        r#"CREATE TABLE IF NOT EXISTS relations (
               id     TEXT PRIMARY KEY,
               fromId TEXT,
               toId   TEXT,
               type   TEXT
           )"#,
        // Declared in the Drizzle schema but missing from the live life-os.db, which is why
        // Google Calendar fails there today. Creating it here closes that drift.
        r#"CREATE TABLE IF NOT EXISTS google_tokens (
               userId       TEXT PRIMARY KEY,
               accessToken  TEXT,
               refreshToken TEXT,
               expiresAt    TEXT,
               calendarId   TEXT
           )"#,
        // The three filters every entity list query uses (`api/src/routes/entities.ts:44-52`).
        "CREATE INDEX IF NOT EXISTS idx_entities_owner_type ON entities(ownerId, type)",
        "CREATE INDEX IF NOT EXISTS idx_entities_parent ON entities(parentId)",
        "CREATE INDEX IF NOT EXISTS idx_trackers_entity ON trackers(entityId)",
    ],
    // v1 -> v2: the wealth tables, carried over from pow.db (db.py MIGRATIONS v1-v5).
    &[
        r#"CREATE TABLE IF NOT EXISTS nw_history (
               grp   TEXT    NOT NULL,   -- account-group id (sanitized)
               d     INTEGER NOT NULL,   -- UTC-midnight epoch ms (day key, client-stamped)
               v     REAL    NOT NULL,   -- net worth, USD
               tiers TEXT,               -- JSON {store,business,trading} or NULL
               debt  REAL,               -- borrow debt netted from v, or NULL
               PRIMARY KEY (grp, d)
           )"#,
        r#"CREATE TABLE IF NOT EXISTS snapshots (
               ts        INTEGER NOT NULL,   -- epoch seconds (server clock)
               grp       TEXT    NOT NULL,
               net_worth REAL    NOT NULL,   -- assets - debt, USD
               assets    REAL,
               debt      REAL,
               btc_usd   REAL,
               btc_sats  REAL,              -- price-invariant BTC reserves
               extra     TEXT               -- JSON escape hatch
           )"#,
        "CREATE INDEX IF NOT EXISTS idx_snapshots_grp_ts ON snapshots(grp, ts)",
        // `archived_at` was pow.db's v4 ALTER; folded in here since this chain starts fresh.
        r#"CREATE TABLE IF NOT EXISTS analyses (
               id             TEXT    PRIMARY KEY,
               scope          TEXT    NOT NULL,
               version        INTEGER NOT NULL,   -- 1-based, per scope
               kind           TEXT    NOT NULL,
               title          TEXT    NOT NULL,
               summary        TEXT,
               body_md        TEXT    NOT NULL,   -- UNTRUSTED LLM text; never eval/render as HTML
               structured     TEXT,               -- JSON {conviction, actions[], evidence[], risks[], tags[]}
               snapshot_as_of INTEGER,
               snapshot_hash  TEXT,               -- anchors the analysis to a data state
               coverage       TEXT,
               net_worth_usd  REAL,
               author         TEXT,
               source         TEXT    NOT NULL,   -- 'mcp' | 'http'
               created_at     INTEGER NOT NULL,
               superseded_by  TEXT,
               archived_at    INTEGER
           )"#,
        "CREATE INDEX IF NOT EXISTS idx_analyses_scope_ver ON analyses(scope, version)",
        "CREATE INDEX IF NOT EXISTS idx_analyses_latest ON analyses(scope) WHERE superseded_by IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_analyses_kind_ts ON analyses(kind, created_at)",
        r#"CREATE TABLE IF NOT EXISTS pos_perf (
               key            TEXT    PRIMARY KEY,        -- "<chainId>:<tokenId>"
               harvest_anchor TEXT,                       -- a change resets the cycle
               cycle_start    INTEGER,
               in_range_secs  REAL    NOT NULL DEFAULT 0,
               last_sample_ts INTEGER
           )"#,
    ],
    // v2 -> v3: the two tables DB_DESIGN.md planned but never built. `alert_state` is what lets
    // notify.py's dedup survive a restart — today it lives in a temp JSON file and does not.
    &[
        r#"CREATE TABLE IF NOT EXISTS kv_cache (
               key        TEXT PRIMARY KEY,
               value_json TEXT    NOT NULL,
               fetched_at INTEGER NOT NULL,   -- epoch seconds
               ttl        INTEGER             -- seconds; NULL = no expiry
           )"#,
        r#"CREATE TABLE IF NOT EXISTS alert_state (
               key        TEXT PRIMARY KEY,
               value_json TEXT    NOT NULL,
               updated_at INTEGER NOT NULL
           )"#,
    ],
    // v3 -> v4: off-chain assets get a server-side home.
    //
    // These lived in the browser's `localStorage` under `lyra:wealth:manual-assets` — which is why
    // `snapshots` could only ever be the on-chain trend, and why the legacy `nw_history` series
    // (which *did* include them) was never comparable with it. One device, no backup, and gone
    // with a cleared cache.
    //
    // `value` is stored in the asset's own denomination with `ccy` naming it, rather than
    // pre-converted to USD: a THB balance is 180,000 THB whatever the rate did today, and
    // converting on write would freeze a rate into what is meant to be a standing fact.
    &[
        r#"CREATE TABLE IF NOT EXISTS manual_assets (
               id         TEXT PRIMARY KEY,
               name       TEXT    NOT NULL,
               kind       TEXT,               -- 'jlp' | 'kgold' | 'lightning' | NULL
               value      REAL,               -- in `ccy`, not USD
               ccy        TEXT,               -- 'usd' | 'thb' | 'sats'; NULL means usd
               units      REAL,
               code       TEXT,
               tier       TEXT    NOT NULL,   -- 'store' | 'business' | 'trading'
               chain      TEXT,
               note       TEXT,
               custody    TEXT,               -- 'cold' | 'custodial'
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
           )"#,
        "CREATE INDEX IF NOT EXISTS idx_manual_assets_tier ON manual_assets(tier)",
    ],
    // v4 -> v5: the wallet list becomes server state.
    //
    // It lived in `ALERT_WALLETS`, which made adding an address an ssh-and-restart job, and in the
    // app it lived only in the browser. The environment stays as the seed and the fallback: an
    // empty table means "use ALERT_WALLETS", so an existing box keeps working untouched.
    //
    // `address` is UNIQUE and stored verbatim — checksummed EVM casing is meaningful to the eye
    // even though lookups are case-insensitive, and a Bitcoin bech32 address is case-sensitive
    // in principle. Duplicates are caught by the index, not by a scan.
    &[
        r#"CREATE TABLE IF NOT EXISTS wallets (
               id         TEXT PRIMARY KEY,
               address    TEXT NOT NULL,
               label      TEXT,               -- what you call it: "cold", "trading", NULL
               kind       TEXT NOT NULL,      -- 'evm' | 'bitcoin' | 'solana', resolved on write
               created_at INTEGER NOT NULL
           )"#,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address COLLATE NOCASE)",
    ],
    // v5 -> v6: the durable job queue.
    //
    // Until now the only background work was two hand-rolled poll loops. Neither has a work item
    // that survives a restart: a digest that fails at 08:00 is gone, and `alert_loop` records the
    // failure in `last_error` and goes round again. This is the table that makes a piece of work a
    // *row* — something that can be retried, backed off, inspected and reclaimed after a kill.
    //
    // Two facts shape the schema, and both are about crashes rather than throughput:
    //
    // * A job is claimed by **lease**, not by a flag. `worker` plus `leased_until` is what lets a
    //   kill -9 be distinguished from slow work: the holder renews the lease while it runs, and a
    //   lease that stops being renewed is reclaimable. A bare `status = 'running'` would strand
    //   the row forever, because nothing would ever say who was meant to be running it.
    // * `run_at` carries the backoff, the schedule and the "not yet" of a delayed retry in one
    //   column, so the claim is always "the oldest runnable job" and never a join.
    //
    // `schedules` is deliberately not this table and never becomes it — see `docs/core-engine.md`.
    // Its `nextDue` is the recurrence's own state, read by the `schedule_list` MCP tool and by
    // `schedule.tick`; a failed job writing a backoff into it would silently slide the user's
    // chores. (This comment used to say the habits page renders it. Nothing in `src/` reads
    // `schedules` at all today — the SPA does recurrence on a task's `dueDate` instead — so do not
    // go looking for that reader.)
    &[
        r#"CREATE TABLE IF NOT EXISTS jobs (
               id              TEXT    PRIMARY KEY,
               kind            TEXT    NOT NULL,   -- 'deliver.telegram', 'schedule.tick', ...
               lane            TEXT    NOT NULL,   -- 'interactive' | 'batch' | 'deliver'
               payload         TEXT    NOT NULL,   -- JSON object; the handler's arguments
               status          TEXT    NOT NULL,   -- 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
               priority        INTEGER NOT NULL DEFAULT 0,   -- higher is claimed first
               run_at          INTEGER NOT NULL,   -- epoch seconds; not runnable before this
               attempts        INTEGER NOT NULL DEFAULT 0,   -- incremented BY the claim, not by the handler
               max_attempts    INTEGER NOT NULL DEFAULT 5,
               idempotency_key TEXT,               -- NULL means "no dedup"; see the partial index
               worker          TEXT,               -- who holds the lease; NULL unless running
               leased_until    INTEGER,            -- epoch seconds; NULL unless running
               last_error      TEXT,
               parent_id       TEXT,               -- the job that enqueued this one
               created_at      INTEGER NOT NULL,
               updated_at      INTEGER NOT NULL,
               finished_at     INTEGER             -- set once, on reaching a terminal status
           )"#,
        // Everything a job did that must not happen twice, keyed by a name the handler chooses.
        //
        // A job is delivered at least once — that is what a lease buys — so a handler that sends a
        // message needs somewhere to record "I already sent it" that survives the reclaim. The
        // CASCADE is what keeps `prune` a single statement.
        r#"CREATE TABLE IF NOT EXISTS job_effects (
               job_id     TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
               key        TEXT    NOT NULL,   -- names the step inside the handler: 'sent', 'row'
               value_json TEXT,               -- what the step returned, replayed on a retry
               created_at INTEGER NOT NULL,
               PRIMARY KEY (job_id, key)
           ) WITHOUT ROWID"#,
        // The claim index. Partial on the status the claim actually scans, so it holds only the
        // runnable backlog rather than every job that ever ran — on a box where the queue is
        // mostly history, that is the difference between an index and a table scan wearing a hat.
        //
        // The predicate is a literal for a reason: SQLite only uses a partial index when the
        // query's WHERE clause provably implies the index's, and a bound `?` proves nothing. Every
        // statement below that wants this index spells `status = 'queued'` out.
        "CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(lane, priority DESC, run_at) WHERE status = 'queued'",
        // The reaper's index: expired leases, and nothing else.
        "CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(leased_until) WHERE status = 'running'",
        // Dedup. UNIQUE *and* partial: a NULL key means "this job is not deduplicated", and
        // without the WHERE clause that would make at most one such job exist at a time.
        //
        // The cost of the partial index is paid at the other end: `ON CONFLICT(idempotency_key)`
        // is a parse error against it. The conflict target has to repeat this predicate verbatim —
        // see `jobs::enqueue`.
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL",
        // What `prune` walks. (It was also described here as what a "recent jobs" listing orders
        // by, which was never true — `recent()` orders by `updated_at`; see v6 -> v7.)
        "CREATE INDEX IF NOT EXISTS idx_jobs_finished ON jobs(finished_at)",
    ],
    // v6 -> v7: the index `recent()` actually sorts on.
    //
    // The queue page polls `recent()` every few seconds and `/retry` resolves a prefix through it,
    // and with no index on `updated_at` each call scanned and sorted the whole table — a cost that
    // grows with the fourteen-day retention window rather than with anything you are looking at.
    // It is written on every claim and heartbeat, so it costs a little on the write side; at a
    // few hundred jobs a day that is nothing.
    &["CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at DESC, id DESC)"],
    // v7 -> v8: notification channels, and which groups reach which of them.
    //
    // Two tables rather than entity rows, because a channel is plumbing: `jobs`, `schedules` and
    // `alert_state` are all infrastructure the same way. `entities` is for life data.
    &[
        r#"CREATE TABLE IF NOT EXISTS channels (
               id          TEXT    PRIMARY KEY,
               name        TEXT    NOT NULL,
               -- 'telegram' | 'discord'. Not an enum: SQLite has none, and the sender registry in
               -- lyra-alerts is the real authority for which transports exist.
               transport   TEXT    NOT NULL,
               -- The credential, sealed (see `secrets.rs`). NULL for a channel whose credential
               -- still comes from the environment, which is how the seeded Telegram row works —
               -- a bot token is a stronger credential than a room webhook and there is no reason
               -- to move it.
               secret       TEXT,
               -- What the UI renders in place of the credential. Never the credential.
               preview      TEXT,
               enabled      INTEGER NOT NULL DEFAULT 1,
               -- Why the last send failed, and since when, so "Discord has been down since
               -- Tuesday" is answerable from the row instead of from the log.
               last_error   TEXT,
               failing_since INTEGER,
               created_at   INTEGER NOT NULL,
               updated_at   INTEGER NOT NULL
           )"#,
        r#"CREATE TABLE IF NOT EXISTS routes (
               id           TEXT    PRIMARY KEY,
               -- `group` is reserved in SQL, so the column is `grp`. Named here rather than quoted
               -- everywhere, because a quoted identifier is a thing someone forgets to quote once.
               grp          TEXT    NOT NULL,
               channel_id   TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
               -- 'info' | 'warning' | 'critical'. A route delivers this level and above.
               min_severity TEXT    NOT NULL DEFAULT 'info',
               -- Local hours, inclusive-exclusive, or NULL for always. Local because the point is
               -- "do not wake me", which is a wall-clock idea.
               quiet_from   INTEGER,
               quiet_to     INTEGER,
               UNIQUE (grp, channel_id)
           )"#,
        // The lookup every notification does: given a group, which channels and at what threshold.
        "CREATE INDEX IF NOT EXISTS idx_routes_grp ON routes(grp)",
    ],
    // v8 -> v9: schedules you can configure, rather than restart to change.
    //
    // Not the `schedules` table, which is habit recurrence and deliberately not a queue — see
    // `docs/core-engine.md`. This is the tick's own list: what to enqueue, and when.
    &[r#"CREATE TABLE IF NOT EXISTS crons (
               id               TEXT    PRIMARY KEY,
               name             TEXT    NOT NULL,
               -- The schedule, as JSON: {"kind":"daily","at_minute":450}. JSON because a cron
               -- expression is a likely fourth variant and a column per field would not hold it.
               schedule         TEXT    NOT NULL,
               -- The job kind to enqueue. Checked against the handler registry on write: an
               -- unregistered kind produces jobs that dead-letter forever, quietly.
               action           TEXT    NOT NULL,
               payload          TEXT    NOT NULL DEFAULT '{}',
               enabled          INTEGER NOT NULL DEFAULT 1,
               -- How late a firing may be and still happen. A brief at 11:00 is useful; a
               -- "start your day" nudge at 11:00 is noise, so it belongs to the cron.
               catch_up_minutes INTEGER NOT NULL DEFAULT 60,
               -- The last occurrence this fired *or* missed, so neither is counted twice. The
               -- exactly-once guarantee is the job's idempotency key, not this column.
               last_occurrence  TEXT,
               last_fired_at    INTEGER,
               -- Slots that went by unfired. Visible, because a schedule that silently stops is
               -- the failure this table exists to prevent.
               missed           INTEGER NOT NULL DEFAULT 0,
               last_missed_at   INTEGER,
               created_at       INTEGER NOT NULL,
               updated_at       INTEGER NOT NULL
           )"#],
    // v9 -> v10: the other systems Lyra speaks for, and the decisions they are waiting on.
    //
    // Lyra is a **courier**, not the book of record: the origin system owns the decision and what
    // it means. These rows exist so an answer survives a reboot and a system that is down, which
    // is the one thing a courier must not get wrong.
    &[
        r#"CREATE TABLE IF NOT EXISTS systems (
               id            TEXT    PRIMARY KEY,
               name          TEXT    NOT NULL,
               base_url      TEXT    NOT NULL,
               -- Sealed with LYRA_SECRET_KEY, AAD = this row's id, exactly as a channel's webhook
               -- is. Never returned; `SystemStore::token_of` is the one door.
               token         TEXT,
               token_preview TEXT,
               -- A JSON array. One coarse scope is enough while Lyra only proposes, but storing a
               -- list from the start means tightening later is data rather than a migration.
               scopes        TEXT    NOT NULL DEFAULT '["read","propose"]',
               enabled       INTEGER NOT NULL DEFAULT 1,
               -- Where the last poll got to. Opaque to Lyra: whatever the system calls a cursor.
               cursor        TEXT,
               last_ok_at    INTEGER,
               last_error    TEXT,
               failing_since INTEGER,
               created_at    INTEGER NOT NULL,
               updated_at    INTEGER NOT NULL
           )"#,
        r#"CREATE TABLE IF NOT EXISTS decisions (
               id           TEXT    PRIMARY KEY,
               system_id    TEXT    NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
               -- The origin's own id for this decision. Paired with the system below as a unique
               -- key, which is what makes polling the same window twice harmless.
               external_id  TEXT    NOT NULL,
               question     TEXT    NOT NULL,
               detail       TEXT,
               -- JSON array of {"value","label"}. An answer must be one of these values.
               options      TEXT    NOT NULL,
               -- Why the system is asking — "castles tested 9% better". Shown with the question,
               -- because a decision without its evidence is a guess.
               evidence     TEXT,
               raised_at    INTEGER NOT NULL,
               expires_at   INTEGER,
               answer       TEXT,
               answered_at  INTEGER,
               -- When the origin confirmed it. NULL with an answer set means still owed, which is
               -- what the delivery job retries on.
               delivered_at INTEGER,
               created_at   INTEGER NOT NULL,
               updated_at   INTEGER NOT NULL,
               UNIQUE(system_id, external_id)
           )"#,
        // The inbox query: everything unanswered, oldest first.
        "CREATE INDEX IF NOT EXISTS idx_decisions_open ON decisions(answered_at, raised_at)",
        // The delivery sweep: answered but not yet confirmed by the origin.
        "CREATE INDEX IF NOT EXISTS idx_decisions_owed ON decisions(delivered_at, answered_at)",
    ],
    // v10 -> v11: the same rows, now also a way in.
    //
    // A launcher tile and a system Lyra talks to are the same thing at different depths, so this
    // is five columns rather than a second table. Two tables would mean registering the factory
    // twice and two health dots that can disagree about it.
    &[
        // `system` — Lyra polls it for decisions. `link` — a tile only, checked for liveness.
        // A router admin page has no /decisions, and polling one paints a permanent red dot from
        // a 404 on a service that is perfectly healthy.
        "ALTER TABLE systems ADD COLUMN kind TEXT NOT NULL DEFAULT 'system'",
        // Where *you* go. `base_url` is where *Lyra* goes, and they are routinely different: the
        // API door is http://factory:8080 while the tile opens https://factory.tailnet.ts.net.
        // Conflating them gives a tile that opens JSON, or a poll aimed at a web page.
        "ALTER TABLE systems ADD COLUMN url TEXT",
        // A lucide name, resolved in the front end. Not a URL: the page is served by the same
        // binary with no internet dependency, and a dashboard full of broken images when the
        // house internet is down is worse than one with letters in circles.
        "ALTER TABLE systems ADD COLUMN icon TEXT",
        "ALTER TABLE systems ADD COLUMN category TEXT",
        "ALTER TABLE systems ADD COLUMN sort INTEGER NOT NULL DEFAULT 0",
    ],
    // v11 -> v12: making your own writing findable.
    //
    // Two unrelated fixes that both belong to the same idea.
    //
    // First, `relations` has been traversed since it was created and indexed on nothing, so every
    // "what links here" is a full scan. Nobody notices at a few hundred edges; the note page gets
    // slow at ten thousand and it looks like the editor.
    &[
        "CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(fromId)",
        "CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(toId)",
        // Second, one index over everything you have written. **It owns nothing** — every row is
        // derived from an `entities` note or a markdown file, and the whole table can be dropped
        // and rebuilt from those. That is the property worth protecting: a bug here costs a
        // re-index, never a note.
        //
        // Both stores feed it because neither can be made subordinate without losing something:
        // the files are git-versioned and editable in any editor, the rows are queryable and
        // related. Indexing both is the only build that keeps both.
        r#"CREATE TABLE IF NOT EXISTS notes (
               id         TEXT    PRIMARY KEY,
               -- 'entity' or 'file'. Which store to go back to, and which ingester owns the row.
               source     TEXT    NOT NULL,
               -- The entity id, or the path relative to LYRA_KNOWLEDGE_PATH.
               ref        TEXT    NOT NULL,
               title      TEXT    NOT NULL,
               body       TEXT    NOT NULL,
               -- Compared on each sweep, so re-indexing touches only what changed.
               updated_at INTEGER NOT NULL,
               indexed_at INTEGER NOT NULL,
               UNIQUE(source, ref)
           )"#,
        // FTS5 with `content=` rather than its own copy of the text: an external-content index
        // stores only the terms and reads the columns back from `notes`. A standalone FTS5 table
        // would hold a second copy of every note, which on a box whose whole database is one file
        // is a doubling nobody asked for.
        r#"CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
               title, body, content='notes', content_rowid='rowid', tokenize='porter unicode61'
           )"#,
        // The triggers are not optional with `content=`: an external-content index is not
        // maintained by SQLite, and without them the table silently returns stale rows forever.
        r#"CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
               INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
           END"#,
        r#"CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
               INSERT INTO notes_fts(notes_fts, rowid, title, body)
               VALUES ('delete', old.rowid, old.title, old.body);
           END"#,
        r#"CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
               INSERT INTO notes_fts(notes_fts, rowid, title, body)
               VALUES ('delete', old.rowid, old.title, old.body);
               INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
           END"#,
    ],
];

/// Applies every migration the database has not seen yet. Returns the resulting `user_version`.
pub async fn migrate(pool: &SqlitePool) -> Result<u32> {
    let current: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .context("reading user_version")?;
    let current = u32::try_from(current.max(0)).unwrap_or(0);

    if current as usize > MIGRATIONS.len() {
        anyhow::bail!(
            "database is at user_version {current} but this binary only knows {}. \
             Refusing to run against a newer schema — use a newer build.",
            MIGRATIONS.len()
        );
    }

    for (index, statements) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = index + 1;
        let mut tx = pool
            .begin()
            .await
            .context("opening migration transaction")?;
        for statement in *statements {
            sqlx::raw_sql(*statement)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("migration v{version}: {}", first_line(statement)))?;
        }
        // PRAGMA does not accept a bound parameter, hence the format!. `version` is a usize
        // from our own iteration, never user input.
        sqlx::raw_sql(AssertSqlSafe(format!("PRAGMA user_version = {version}")))
            .execute(&mut *tx)
            .await
            .with_context(|| format!("stamping user_version = {version}"))?;
        tx.commit()
            .await
            .with_context(|| format!("committing migration v{version}"))?;
        tracing::info!(version, "applied migration");
    }

    Ok(MIGRATIONS.len() as u32)
}

fn first_line(statement: &str) -> &str {
    statement.trim().lines().next().unwrap_or(statement).trim()
}
