//! The other systems Lyra speaks for, and the decisions they are waiting on.
//!
//! Lyra is a **courier**. The origin system raises a decision, owns what it means, and acts on the
//! answer; Lyra's job is to carry the question to a phone and the answer back, and to not lose
//! either one. Everything in this file follows from that:
//!
//! - **A decision is unique per `(system, external_id)`.** Polling the same window twice is normal —
//!   a cursor that did not advance, a restart mid-sweep — and must produce one row, not two.
//! - **The answer is committed before it is delivered.** `answer` and `delivered_at` are separate
//!   columns for exactly that reason: answered-but-not-delivered is a real state that the delivery
//!   job retries, rather than a tap that vanished because the origin was down.
//! - **The token never comes back out.** Sealed the way a Discord webhook is, with the row id as
//!   AAD so a token cannot be moved between systems, and [`SystemStore::token_of`] is the one door.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::channels::random_id;
use crate::secrets;

/// A system as the API and the UI see it. **No token.**
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct System {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// What to show instead of the token — enough to tell two apart, useless to anyone else.
    pub token_preview: Option<String>,
    pub stored_token: bool,
    pub scopes: Vec<String>,
    pub enabled: bool,
    /// Where the last poll got to. Opaque: whatever the system calls a cursor.
    pub cursor: Option<String>,
    pub last_ok_at: Option<i64>,
    pub last_error: Option<String>,
    pub failing_since: Option<i64>,
}

/// One answer a decision will accept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Option_ {
    pub value: String,
    pub label: String,
}

/// Something a system is waiting on you for.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Decision {
    pub id: String,
    pub system_id: String,
    pub external_id: String,
    pub question: String,
    pub detail: Option<String>,
    pub options: Vec<Option_>,
    /// Why the system is asking. A decision without its evidence is a guess.
    pub evidence: Option<String>,
    pub raised_at: i64,
    pub expires_at: Option<i64>,
    pub answer: Option<String>,
    pub answered_at: Option<i64>,
    /// When the origin confirmed it. An answer with no confirmation is still owed.
    pub delivered_at: Option<i64>,
}

impl Decision {
    /// Whether this decision can still be answered usefully.
    ///
    /// Expiry is the origin's statement about its own deadline, so an expired decision is shown and
    /// not deleted — "you missed this" is information, and silently dropping it would leave the
    /// inbox looking clean while the factory waited.
    pub fn expired(&self, now: i64) -> bool {
        self.answered_at.is_none() && self.expires_at.is_some_and(|at| at <= now)
    }
}

/// What to write when registering or editing a system.
#[derive(Debug, Clone, Default)]
pub struct SystemInput {
    pub name: String,
    pub base_url: String,
    /// The token in the clear. Sealed before it is stored, and never read back.
    pub token: Option<String>,
    pub scopes: Vec<String>,
}

/// A partial edit. `None` everywhere means "change nothing", and `token: None` in particular means
/// "leave the stored one alone" — the UI was never given it, so absence is the only way to say so.
#[derive(Debug, Clone, Default)]
pub struct SystemPatch {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

/// What one system reported when asked what is new.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Raised {
    pub system_id: String,
    pub external_id: String,
    pub question: String,
    pub detail: Option<String>,
    pub options: Vec<Option_>,
    pub evidence: Option<String>,
    pub raised_at: i64,
    pub expires_at: Option<i64>,
}

pub struct SystemStore {
    pool: SqlitePool,
    /// The sealing key, resolved once when the store is built — a field rather than a read of the
    /// process environment per call, which made the channel tests race when it was written that way.
    key: Option<Vec<u8>>,
}

impl SystemStore {
    pub fn from_env(pool: SqlitePool) -> Self {
        Self::new(pool, secrets::key_from_env())
    }

    pub fn new(pool: SqlitePool, key: Option<Vec<u8>>) -> Self {
        Self { pool, key }
    }

    pub async fn list(&self) -> Result<Vec<System>> {
        let rows = sqlx::query(
            "SELECT id, name, base_url, token, token_preview, scopes, enabled, cursor,
                    last_ok_at, last_error, failing_since
               FROM systems ORDER BY name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await
        .context("listing systems")?;
        Ok(rows.iter().map(row_to_system).collect())
    }

    /// Only the ones a sweep should talk to.
    pub async fn enabled(&self) -> Result<Vec<System>> {
        Ok(self
            .list()
            .await?
            .into_iter()
            .filter(|s| s.enabled)
            .collect())
    }

    pub async fn get(&self, id: &str) -> Result<Option<System>> {
        let row = sqlx::query(
            "SELECT id, name, base_url, token, token_preview, scopes, enabled, cursor,
                    last_ok_at, last_error, failing_since
               FROM systems WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("reading a system")?;
        Ok(row.as_ref().map(row_to_system))
    }

    pub async fn create(&self, input: &SystemInput, now: i64) -> Result<System> {
        let id = format!("sys-{}", random_id());
        let (sealed, preview) = self.seal_for(&id, input.token.as_deref())?;

        sqlx::query(
            "INSERT INTO systems (id, name, base_url, token, token_preview, scopes, enabled,
                                  created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(input.name.trim())
        .bind(input.base_url.trim_end_matches('/'))
        .bind(&sealed)
        .bind(&preview)
        .bind(scopes_json(&input.scopes))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("registering a system")?;

        self.get(&id)
            .await?
            .context("the system vanished between writing and reading it")
    }

    pub async fn update(&self, id: &str, patch: &SystemPatch, now: i64) -> Result<Option<System>> {
        if self.get(id).await?.is_none() {
            return Ok(None);
        }
        // One literal statement per field. Building the SET clause with `format!` is refused by
        // this repo's dynamic-SQL guard, and the repetition is the price of that.
        if let Some(name) = &patch.name {
            sqlx::query("UPDATE systems SET name = ?, updated_at = ? WHERE id = ?")
                .bind(name.trim())
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("renaming a system")?;
        }
        if let Some(base_url) = &patch.base_url {
            // Moving a system clears the cursor: positions are meaningless against a different
            // host, and resuming from a stale one would silently skip whatever it had raised.
            sqlx::query(
                "UPDATE systems SET base_url = ?, cursor = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(base_url.trim_end_matches('/'))
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("moving a system")?;
        }
        if let Some(token) = &patch.token {
            let (sealed, preview) = self.seal_for(id, Some(token))?;
            // A new token clears the failure state: what was failing may be exactly the thing just
            // replaced, and leaving "failing since Tuesday" on a fixed system teaches you to ignore
            // that field.
            sqlx::query(
                "UPDATE systems
                    SET token = ?, token_preview = ?, last_error = NULL, failing_since = NULL,
                        updated_at = ?
                  WHERE id = ?",
            )
            .bind(&sealed)
            .bind(&preview)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("storing a system token")?;
        }
        if let Some(scopes) = &patch.scopes {
            sqlx::query("UPDATE systems SET scopes = ?, updated_at = ? WHERE id = ?")
                .bind(scopes_json(scopes))
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("setting a system's scopes")?;
        }
        if let Some(enabled) = patch.enabled {
            sqlx::query("UPDATE systems SET enabled = ?, updated_at = ? WHERE id = ?")
                .bind(i64::from(enabled))
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("enabling a system")?;
        }
        self.get(id).await
    }

    /// Remove a system and the decisions it raised.
    ///
    /// The decisions go with it, by `ON DELETE CASCADE`: a decision is a question from somewhere,
    /// and a question with no asker cannot be answered or delivered. What you *said* is not lost
    /// with them — a delivered answer already reached the origin, which is the book of record.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let done = sqlx::query("DELETE FROM systems WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting a system")?;
        Ok(done.rows_affected() > 0)
    }

    /// The token for a system, unsealed. The only way to get it, named so the call site reads as
    /// what it is holding.
    pub async fn token_of(&self, id: &str) -> Result<Option<String>> {
        let sealed: Option<String> = sqlx::query_scalar("SELECT token FROM systems WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a system token")?
            .flatten();

        let Some(sealed) = sealed else {
            return Ok(None);
        };
        let key = self.key.as_deref().with_context(|| {
            format!(
                "{} is not set, so a stored token cannot be unsealed",
                secrets::KEY_VAR
            )
        })?;
        secrets::unseal(key, id, &sealed).map(Some)
    }

    pub async fn record_failure(&self, id: &str, error: &str, now: i64) -> Result<()> {
        sqlx::query(
            "UPDATE systems
                SET last_error = ?, failing_since = COALESCE(failing_since, ?), updated_at = ?
              WHERE id = ?",
        )
        .bind(error)
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("recording a system failure")?;
        Ok(())
    }

    /// A good poll: clears the failure state and moves the cursor.
    ///
    /// The two travel together because a cursor advanced without a successful read would skip
    /// whatever was in the window, and a success recorded without the cursor would read it again.
    pub async fn record_success(&self, id: &str, cursor: Option<&str>, now: i64) -> Result<()> {
        sqlx::query(
            "UPDATE systems
                SET last_ok_at = ?, last_error = NULL, failing_since = NULL,
                    cursor = COALESCE(?, cursor), updated_at = ?
              WHERE id = ?",
        )
        .bind(now)
        .bind(cursor)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("recording a system poll")?;
        Ok(())
    }

    fn seal_for(&self, id: &str, token: Option<&str>) -> Result<(Option<String>, Option<String>)> {
        let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
            return Ok((None, None));
        };
        let Some(key) = self.key.as_deref() else {
            bail!(
                "{} is not set, so a token cannot be stored. Generate one with \
                 `openssl rand -base64 32` and add it to .env.local.",
                secrets::KEY_VAR
            );
        };
        Ok((
            Some(secrets::seal(key, id, token)?),
            Some(secrets::preview(token)),
        ))
    }
}

/// The decisions half. No sealing here — a question is not a credential.
pub struct DecisionStore {
    pool: SqlitePool,
}

impl DecisionStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Record what a poll found, and say how many were new.
    ///
    /// `ON CONFLICT DO NOTHING` against `(system_id, external_id)` is the whole exactly-once story:
    /// re-reading a window because a cursor did not advance, or because the process restarted
    /// mid-sweep, is the normal case rather than an error. **Do nothing, not upsert** — an update
    /// would let the origin rewrite a question you have already been asked, and in the worst case
    /// change what you were agreeing to between the notification and the tap.
    pub async fn raise(&self, raised: &[Raised], now: i64) -> Result<usize> {
        let mut new = 0;
        for one in raised {
            let done = sqlx::query(
                "INSERT INTO decisions (id, system_id, external_id, question, detail, options,
                                        evidence, raised_at, expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(system_id, external_id) DO NOTHING",
            )
            .bind(format!("dec-{}", random_id()))
            .bind(&one.system_id)
            .bind(&one.external_id)
            .bind(&one.question)
            .bind(&one.detail)
            .bind(serde_json::to_string(&one.options).unwrap_or_else(|_| "[]".into()))
            .bind(&one.evidence)
            .bind(one.raised_at)
            .bind(one.expires_at)
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await
            .context("recording a raised decision")?;
            new += done.rows_affected() as usize;
        }
        Ok(new)
    }

    /// Everything still waiting on you, oldest first — the inbox.
    pub async fn open(&self) -> Result<Vec<Decision>> {
        let rows =
            sqlx::query("SELECT * FROM decisions WHERE answered_at IS NULL ORDER BY raised_at ASC")
                .fetch_all(&self.pool)
                .await
                .context("listing open decisions")?;
        Ok(rows.iter().map(row_to_decision).collect())
    }

    /// Recently answered as well as open, for the screen that shows what you decided.
    pub async fn recent(&self, limit: usize) -> Result<Vec<Decision>> {
        let limit = limit.clamp(1, 200) as i64;
        let rows = sqlx::query(
            "SELECT * FROM decisions
              ORDER BY answered_at IS NOT NULL, raised_at DESC
              LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("listing decisions")?;
        Ok(rows.iter().map(row_to_decision).collect())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Decision>> {
        let row = sqlx::query("SELECT * FROM decisions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a decision")?;
        Ok(row.as_ref().map(row_to_decision))
    }

    /// Answer one. Returns the decision, or `None` if there is no such row.
    ///
    /// **The first answer wins.** `WHERE answered_at IS NULL` makes a second tap — the button
    /// pressed twice, the same callback delivered twice by Telegram — a no-op rather than a
    /// different instruction sent to the origin after the first one was already delivered.
    ///
    /// The answer must be one of the offered values; the caller checks that and this refuses to
    /// guess, because a free-text answer is not something the origin agreed to accept.
    pub async fn answer(&self, id: &str, answer: &str, now: i64) -> Result<Option<Decision>> {
        sqlx::query(
            "UPDATE decisions
                SET answer = ?, answered_at = ?, updated_at = ?
              WHERE id = ? AND answered_at IS NULL",
        )
        .bind(answer)
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("answering a decision")?;
        self.get(id).await
    }

    /// Answered, but the origin has not confirmed it yet — what the delivery job is for.
    pub async fn owed(&self, limit: usize) -> Result<Vec<Decision>> {
        let limit = limit.clamp(1, 200) as i64;
        let rows = sqlx::query(
            "SELECT * FROM decisions
              WHERE answered_at IS NOT NULL AND delivered_at IS NULL
              ORDER BY answered_at ASC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("listing undelivered answers")?;
        Ok(rows.iter().map(row_to_decision).collect())
    }

    pub async fn mark_delivered(&self, id: &str, now: i64) -> Result<()> {
        sqlx::query("UPDATE decisions SET delivered_at = ?, updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("marking an answer delivered")?;
        Ok(())
    }
}

fn scopes_json(scopes: &[String]) -> String {
    // The default is the one Lyra actually operates under while it is a courier: read everything,
    // propose nothing binding. Stored as a list so tightening it later is data, not a migration.
    if scopes.is_empty() {
        return r#"["read","propose"]"#.to_string();
    }
    serde_json::to_string(scopes).unwrap_or_else(|_| r#"["read","propose"]"#.to_string())
}

fn row_to_system(row: &sqlx::sqlite::SqliteRow) -> System {
    let sealed: Option<String> = row.try_get("token").unwrap_or(None);
    let scopes: String = row.try_get("scopes").unwrap_or_default();
    System {
        id: row.get("id"),
        name: row.get("name"),
        base_url: row.get("base_url"),
        token_preview: row.try_get("token_preview").unwrap_or(None),
        stored_token: sealed.is_some(),
        scopes: serde_json::from_str(&scopes).unwrap_or_default(),
        enabled: row.try_get::<i64, _>("enabled").unwrap_or(1) != 0,
        cursor: row.try_get("cursor").unwrap_or(None),
        last_ok_at: row.try_get("last_ok_at").unwrap_or(None),
        last_error: row.try_get("last_error").unwrap_or(None),
        failing_since: row.try_get("failing_since").unwrap_or(None),
    }
}

fn row_to_decision(row: &sqlx::sqlite::SqliteRow) -> Decision {
    let options: String = row.try_get("options").unwrap_or_default();
    Decision {
        id: row.get("id"),
        system_id: row.get("system_id"),
        external_id: row.get("external_id"),
        question: row.get("question"),
        detail: row.try_get("detail").unwrap_or(None),
        options: serde_json::from_str(&options).unwrap_or_default(),
        evidence: row.try_get("evidence").unwrap_or(None),
        raised_at: row.try_get("raised_at").unwrap_or(0),
        expires_at: row.try_get("expires_at").unwrap_or(None),
        answer: row.try_get("answer").unwrap_or(None),
        answered_at: row.try_get("answered_at").unwrap_or(None),
        delivered_at: row.try_get("delivered_at").unwrap_or(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const KEY: [u8; 32] = [7u8; 32];

    async fn store() -> (TempDir, SystemStore, DecisionStore) {
        let dir = TempDir::new().unwrap();
        let pool = crate::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (
            dir,
            SystemStore::new(pool.clone(), Some(KEY.to_vec())),
            DecisionStore::new(pool),
        )
    }

    fn factory() -> SystemInput {
        SystemInput {
            name: "content-factory".into(),
            base_url: "http://factory.tail-scale.ts.net:8080/".into(),
            token: Some("ceo-token-abcdef123456".into()),
            scopes: vec![],
        }
    }

    fn question(external_id: &str) -> Raised {
        Raised {
            system_id: String::new(),
            external_id: external_id.into(),
            question: "Medieval week 1: castles or alliances?".into(),
            detail: Some("next week's order".into()),
            options: vec![
                Option_ {
                    value: "castles".into(),
                    label: "Castles".into(),
                },
                Option_ {
                    value: "alliances".into(),
                    label: "Alliances".into(),
                },
            ],
            evidence: Some("castles tested 9% better in the Ancient finale".into()),
            raised_at: 1000,
            expires_at: None,
        }
    }

    #[tokio::test]
    async fn a_token_is_sealed_and_never_comes_back_in_a_listing() {
        let (_dir, systems, _) = store().await;
        let made = systems.create(&factory(), 1000).await.unwrap();

        // Serialised the way the API returns it — the one shape a leak would travel in.
        let wire = serde_json::to_string(&systems.list().await.unwrap()).unwrap();
        assert!(
            !wire.contains("ceo-token-abcdef123456"),
            "a token reached the wire: {wire}"
        );
        assert!(wire.contains("stored_token\":true"), "{wire}");
        assert_eq!(
            systems.token_of(&made.id).await.unwrap().as_deref(),
            Some("ceo-token-abcdef123456"),
            "the one door still opens"
        );
        // The trailing slash is dropped on write, so joining a path cannot produce `//`.
        assert_eq!(made.base_url, "http://factory.tail-scale.ts.net:8080");
        assert_eq!(made.scopes, vec!["read", "propose"], "the default scopes");
    }

    /// A token cannot be lifted from one system's row into another's.
    #[tokio::test]
    async fn a_sealed_token_does_not_travel_between_systems() {
        let (_dir, systems, _) = store().await;
        let a = systems.create(&factory(), 1000).await.unwrap();
        let mut second = factory();
        second.name = "finance".into();
        second.token = Some("other-token".into());
        let b = systems.create(&second, 1000).await.unwrap();

        let sealed_a: Option<String> = sqlx::query_scalar("SELECT token FROM systems WHERE id = ?")
            .bind(&a.id)
            .fetch_one(&systems.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE systems SET token = ? WHERE id = ?")
            .bind(&sealed_a)
            .bind(&b.id)
            .execute(&systems.pool)
            .await
            .unwrap();

        assert!(
            systems.token_of(&b.id).await.is_err(),
            "the row id is the AAD, so a copied token must not unseal"
        );
    }

    #[tokio::test]
    async fn editing_a_system_leaves_a_token_it_was_not_given() {
        let (_dir, systems, _) = store().await;
        let made = systems.create(&factory(), 1000).await.unwrap();

        systems
            .update(
                &made.id,
                &SystemPatch {
                    name: Some("the factory".into()),
                    ..Default::default()
                },
                1010,
            )
            .await
            .unwrap();

        assert_eq!(
            systems.token_of(&made.id).await.unwrap().as_deref(),
            Some("ceo-token-abcdef123456"),
            "a rename must not erase the credential it was never shown"
        );
    }

    /// Moving a system must not resume from a cursor that belonged to the old host.
    #[tokio::test]
    async fn moving_a_system_forgets_where_the_last_poll_got_to() {
        let (_dir, systems, _) = store().await;
        let made = systems.create(&factory(), 1000).await.unwrap();
        systems
            .record_success(&made.id, Some("evt-42"), 1010)
            .await
            .unwrap();
        assert_eq!(
            systems
                .get(&made.id)
                .await
                .unwrap()
                .unwrap()
                .cursor
                .as_deref(),
            Some("evt-42")
        );

        systems
            .update(
                &made.id,
                &SystemPatch {
                    base_url: Some("http://elsewhere:9000".into()),
                    ..Default::default()
                },
                1020,
            )
            .await
            .unwrap();

        assert_eq!(
            systems.get(&made.id).await.unwrap().unwrap().cursor,
            None,
            "a cursor means nothing against a different host"
        );
    }

    /// Polling the same window twice is normal and must not ask you the same thing twice.
    #[tokio::test]
    async fn the_same_question_polled_twice_is_one_row() {
        let (_dir, systems, decisions) = store().await;
        let sys = systems.create(&factory(), 1000).await.unwrap();
        let mut one = question("dec-7");
        one.system_id = sys.id.clone();

        assert_eq!(decisions.raise(&[one.clone()], 1000).await.unwrap(), 1);
        assert_eq!(
            decisions.raise(&[one.clone()], 1030).await.unwrap(),
            0,
            "the second poll of the same window raises nothing new"
        );
        assert_eq!(decisions.open().await.unwrap().len(), 1);

        // And the origin cannot rewrite the question after you have been asked it.
        let mut changed = one.clone();
        changed.question = "Delete everything?".into();
        decisions.raise(&[changed], 1060).await.unwrap();
        assert_eq!(
            decisions.open().await.unwrap()[0].question,
            "Medieval week 1: castles or alliances?"
        );
    }

    /// The rule the courier turns on: the answer is committed here, and delivery is a separate fact.
    #[tokio::test]
    async fn an_answer_is_owed_until_the_origin_confirms_it() {
        let (_dir, systems, decisions) = store().await;
        let sys = systems.create(&factory(), 1000).await.unwrap();
        let mut one = question("dec-7");
        one.system_id = sys.id.clone();
        decisions.raise(&[one], 1000).await.unwrap();
        let id = decisions.open().await.unwrap()[0].id.clone();

        let answered = decisions
            .answer(&id, "castles", 1100)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(answered.answer.as_deref(), Some("castles"));
        assert_eq!(answered.delivered_at, None);
        assert!(decisions.open().await.unwrap().is_empty(), "off the inbox");
        assert_eq!(decisions.owed(10).await.unwrap().len(), 1, "still owed");

        decisions.mark_delivered(&id, 1200).await.unwrap();
        assert!(
            decisions.owed(10).await.unwrap().is_empty(),
            "confirmed by the origin, so nothing is owed"
        );
    }

    /// A button pressed twice must not send a second, different instruction.
    #[tokio::test]
    async fn the_first_answer_wins() {
        let (_dir, systems, decisions) = store().await;
        let sys = systems.create(&factory(), 1000).await.unwrap();
        let mut one = question("dec-7");
        one.system_id = sys.id.clone();
        decisions.raise(&[one], 1000).await.unwrap();
        let id = decisions.open().await.unwrap()[0].id.clone();

        decisions.answer(&id, "castles", 1100).await.unwrap();
        let second = decisions
            .answer(&id, "alliances", 1150)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            second.answer.as_deref(),
            Some("castles"),
            "the second tap is a no-op, not a new instruction"
        );
        assert_eq!(second.answered_at, Some(1100));
    }

    #[tokio::test]
    async fn deleting_a_system_takes_its_questions_with_it() {
        let (_dir, systems, decisions) = store().await;
        let sys = systems.create(&factory(), 1000).await.unwrap();
        let mut one = question("dec-7");
        one.system_id = sys.id.clone();
        decisions.raise(&[one], 1000).await.unwrap();

        assert!(systems.delete(&sys.id).await.unwrap());
        assert!(
            decisions.open().await.unwrap().is_empty(),
            "a question with no asker cannot be answered or delivered"
        );
    }

    #[tokio::test]
    async fn an_expiry_that_has_passed_is_shown_rather_than_dropped() {
        let (_dir, systems, decisions) = store().await;
        let sys = systems.create(&factory(), 1000).await.unwrap();
        let mut one = question("dec-7");
        one.system_id = sys.id.clone();
        one.expires_at = Some(1500);
        decisions.raise(&[one], 1000).await.unwrap();

        let open = decisions.open().await.unwrap();
        assert_eq!(open.len(), 1, "still in the inbox");
        assert!(!open[0].expired(1400));
        assert!(open[0].expired(1500), "'you missed this' is information");
    }

    #[tokio::test]
    async fn without_a_key_a_token_is_refused_by_name_rather_than_stored_in_the_clear() {
        let dir = TempDir::new().unwrap();
        let pool = crate::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let keyless = SystemStore::new(pool, None);

        let refused = keyless.create(&factory(), 1000).await.unwrap_err();
        assert!(
            refused.to_string().contains(secrets::KEY_VAR),
            "the refusal must name the variable: {refused}"
        );
        // A system with no token at all is fine — a local service on the same host may not want one.
        let mut open = factory();
        open.token = None;
        assert!(keyless.create(&open, 1000).await.is_ok());
    }
}
