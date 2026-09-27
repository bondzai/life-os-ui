//! Notification channels, and which groups reach which of them.
//!
//! A channel is a destination — one Discord room, one Telegram chat. A route says a group of
//! notifications goes to a channel, above a severity, outside quiet hours. Together they replace
//! "everything configured receives everything", which was the only policy the environment could
//! express.
//!
//! The credential is sealed (see [`crate::secrets`]) and this module never hands it out by accident:
//! [`Channel`] carries only the preview, and the sealed value is reachable only through
//! [`ChannelStore::secret_of`], which names what it is doing.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::secrets;

/// How loud a notification is. A route delivers this level and above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }

    /// Unknown text reads as `Info`, deliberately.
    ///
    /// The alternative is refusing to deliver something because its severity was misspelled, and a
    /// notification that does not arrive is worse than one that arrives on a channel you would
    /// rather it had not.
    pub fn parse(text: &str) -> Self {
        match text {
            "critical" => Self::Critical,
            "warning" => Self::Warning,
            _ => Self::Info,
        }
    }
}

/// A destination, as the API and the UI see it. **No credential.**
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub transport: String,
    /// What to show instead of the credential. `None` for a channel whose credential is in the
    /// environment, where there is nothing stored to preview.
    pub preview: Option<String>,
    /// Whether the credential lives in this row at all, so the UI can say "from .env.local" rather
    /// than showing an empty field that looks broken.
    pub stored_secret: bool,
    pub enabled: bool,
    pub last_error: Option<String>,
    pub failing_since: Option<i64>,
}

/// A group's delivery rule for one channel.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Route {
    pub id: String,
    pub group: String,
    pub channel_id: String,
    pub min_severity: Severity,
    pub quiet_from: Option<i64>,
    pub quiet_to: Option<i64>,
}

impl Route {
    /// Whether this route carries a notification of `severity` at local hour `hour`.
    ///
    /// Quiet hours wrap: `22..7` means the evening and the small hours, which is the only way
    /// anyone actually wants to express it. A route with one bound set and not the other is treated
    /// as having no quiet hours, because half a range is a half-finished edit rather than an
    /// instruction.
    pub fn carries(&self, severity: Severity, hour: i64) -> bool {
        if severity < self.min_severity {
            return false;
        }
        match (self.quiet_from, self.quiet_to) {
            (Some(from), Some(to)) if from != to => {
                let quiet = if from < to {
                    (from..to).contains(&hour)
                } else {
                    hour >= from || hour < to
                };
                // Critical ignores quiet hours. A liquidation at 3am is the message you would be
                // angry to have been protected from.
                !quiet || severity == Severity::Critical
            }
            _ => true,
        }
    }
}

/// What to write when creating or updating a channel.
#[derive(Debug, Clone, Default)]
pub struct ChannelInput {
    pub name: String,
    pub transport: String,
    /// The credential in the clear. Sealed before it is stored, and never read back.
    pub secret: Option<String>,
}

pub struct ChannelStore {
    pool: SqlitePool,
    /// The sealing key, resolved once when the store is built.
    ///
    /// A field rather than a read of the process environment at each call, and that is not only
    /// tidiness: reading a global made the tests race — one that needed *no* key had to unset the
    /// variable, and unset it for every test running beside it. An explicit dependency cannot do
    /// that, and the app reads the environment exactly once, in [`Self::from_env`].
    key: Option<Vec<u8>>,
}

impl ChannelStore {
    /// The app's constructor: the key comes from the environment.
    pub fn from_env(pool: SqlitePool) -> Self {
        Self::new(pool, secrets::key_from_env())
    }

    pub fn new(pool: SqlitePool, key: Option<Vec<u8>>) -> Self {
        Self { pool, key }
    }

    pub async fn list(&self) -> Result<Vec<Channel>> {
        let rows = sqlx::query(
            "SELECT id, name, transport, preview, secret IS NOT NULL AS stored, enabled,
                    last_error, failing_since
               FROM channels ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .context("listing channels")?;

        Ok(rows.iter().map(row_to_channel).collect())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Channel>> {
        let row = sqlx::query(
            "SELECT id, name, transport, preview, secret IS NOT NULL AS stored, enabled,
                    last_error, failing_since
               FROM channels WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("reading a channel")?;

        Ok(row.as_ref().map(row_to_channel))
    }

    /// Create a channel, sealing its credential if it has one.
    ///
    /// The id is generated here rather than taken, because it is bound into the seal: a caller that
    /// chose its own id could seal a secret under one id and store it under another.
    pub async fn create(&self, input: &ChannelInput, now: i64) -> Result<Channel> {
        let id = format!("chan-{}", uuid());
        let (sealed, preview) = self.seal_for(&id, input.secret.as_deref())?;

        sqlx::query(
            "INSERT INTO channels (id, name, transport, secret, preview, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(&input.transport)
        .bind(&sealed)
        .bind(&preview)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("creating a channel")?;

        self.get(&id)
            .await?
            .context("the channel vanished between writing and reading it")
    }

    /// Update a channel. `secret: None` leaves the stored credential alone.
    ///
    /// That distinction is the whole point of the write-only field: the UI cannot send back a
    /// credential it was never given, so "unchanged" has to be expressible as its absence.
    pub async fn update(
        &self,
        id: &str,
        name: Option<&str>,
        secret: Option<&str>,
        enabled: Option<bool>,
        now: i64,
    ) -> Result<Option<Channel>> {
        if self.get(id).await?.is_none() {
            return Ok(None);
        }
        if let Some(name) = name {
            sqlx::query("UPDATE channels SET name = ?, updated_at = ? WHERE id = ?")
                .bind(name)
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("renaming a channel")?;
        }
        if let Some(secret) = secret {
            let (sealed, preview) = self.seal_for(id, Some(secret))?;
            // A new credential clears the failure state: the reason it was failing may be exactly
            // the thing just replaced, and leaving "failing since Tuesday" on a fixed channel
            // teaches you to ignore that field.
            sqlx::query(
                "UPDATE channels
                    SET secret = ?, preview = ?, last_error = NULL, failing_since = NULL,
                        updated_at = ?
                  WHERE id = ?",
            )
            .bind(&sealed)
            .bind(&preview)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("storing a channel credential")?;
        }
        if let Some(enabled) = enabled {
            sqlx::query("UPDATE channels SET enabled = ?, updated_at = ? WHERE id = ?")
                .bind(i64::from(enabled))
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("enabling a channel")?;
        }
        self.get(id).await
    }

    /// Remove a channel and its routes.
    ///
    /// A hard delete is safe here: the delivery history lives in `jobs`, whose payloads name the
    /// channel by id and hold no foreign key, so removing a channel does not erase what was sent
    /// through it. Routes go with it, which is what `ON DELETE CASCADE` is for.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let done = sqlx::query("DELETE FROM channels WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting a channel")?;
        Ok(done.rows_affected() > 0)
    }

    /// The credential for a channel, unsealed. The only way to get it, and named so that a reader
    /// of the call site knows what it is holding.
    ///
    /// `Ok(None)` means the credential is not in this row — it comes from the environment, which is
    /// how the seeded Telegram channel works.
    pub async fn secret_of(&self, id: &str) -> Result<Option<String>> {
        let sealed: Option<String> = sqlx::query_scalar("SELECT secret FROM channels WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a channel credential")?
            .flatten();

        let Some(sealed) = sealed else {
            return Ok(None);
        };
        let key = self.key.as_deref().with_context(|| {
            format!(
                "{} is not set, so a stored credential cannot be unsealed",
                secrets::KEY_VAR
            )
        })?;
        secrets::unseal(key, id, &sealed).map(Some)
    }

    /// Record that a send through this channel failed, keeping the first time it started failing.
    pub async fn record_failure(&self, id: &str, error: &str, now: i64) -> Result<()> {
        sqlx::query(
            "UPDATE channels
                SET last_error = ?, failing_since = COALESCE(failing_since, ?), updated_at = ?
              WHERE id = ?",
        )
        .bind(error)
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("recording a channel failure")?;
        Ok(())
    }

    /// Record that a send through this channel worked, clearing any failure.
    pub async fn record_success(&self, id: &str, now: i64) -> Result<()> {
        sqlx::query(
            "UPDATE channels SET last_error = NULL, failing_since = NULL, updated_at = ?
              WHERE id = ?",
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("clearing a channel failure")?;
        Ok(())
    }

    /* ─── routes ─── */

    pub async fn routes(&self) -> Result<Vec<Route>> {
        let rows = sqlx::query(
            "SELECT id, grp, channel_id, min_severity, quiet_from, quiet_to
               FROM routes ORDER BY grp, channel_id",
        )
        .fetch_all(&self.pool)
        .await
        .context("listing routes")?;
        Ok(rows.iter().map(row_to_route).collect())
    }

    /// Replace the whole routing table in one transaction.
    ///
    /// The matrix is edited as a matrix, so it is written as one: a per-row API would let a save
    /// half-apply and leave a group delivering to a channel the user had just unticked.
    pub async fn set_routes(&self, routes: &[Route]) -> Result<()> {
        let mut tx = self.pool.begin().await.context("replacing routes")?;
        sqlx::query("DELETE FROM routes")
            .execute(&mut *tx)
            .await
            .context("clearing routes")?;
        for route in routes {
            sqlx::query(
                "INSERT INTO routes (id, grp, channel_id, min_severity, quiet_from, quiet_to)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(format!("route-{}", uuid()))
            .bind(&route.group)
            .bind(&route.channel_id)
            .bind(route.min_severity.as_str())
            .bind(route.quiet_from)
            .bind(route.quiet_to)
            .execute(&mut *tx)
            .await
            .context("inserting a route")?;
        }
        tx.commit().await.context("committing routes")?;
        Ok(())
    }

    /// Which enabled channels should receive a notification in `group` at `severity` and local
    /// `hour`.
    ///
    /// The join is the whole routing decision, in one query: a route with no channel, a route to a
    /// disabled channel, and a severity below the threshold all drop out here rather than being
    /// filtered by a caller that might forget one.
    pub async fn destinations(
        &self,
        group: &str,
        severity: Severity,
        hour: i64,
    ) -> Result<Vec<String>> {
        let rows = sqlx::query(
            "SELECT r.id, r.grp, r.channel_id, r.min_severity, r.quiet_from, r.quiet_to
               FROM routes r
               JOIN channels c ON c.id = r.channel_id
              WHERE r.grp = ? AND c.enabled = 1
              ORDER BY c.name",
        )
        .bind(group)
        .fetch_all(&self.pool)
        .await
        .context("resolving destinations")?;

        Ok(rows
            .iter()
            .map(row_to_route)
            // Severity and quiet hours are decided in Rust rather than SQL because
            // `Route::carries` is the same rule the UI needs to explain, and two copies of it in
            // two languages is how they stop agreeing.
            .filter(|route| route.carries(severity, hour))
            .map(|route| route.channel_id)
            .collect())
    }

    fn seal_for(&self, id: &str, secret: Option<&str>) -> Result<(Option<String>, Option<String>)> {
        let Some(secret) = secret.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok((None, None));
        };
        let Some(key) = self.key.as_deref() else {
            bail!(
                "{} is not set, so a credential cannot be stored. Generate one with \
                 `openssl rand -base64 32` and add it to .env.local.",
                secrets::KEY_VAR
            );
        };
        Ok((
            Some(secrets::seal(key, id, secret)?),
            Some(secrets::preview(secret)),
        ))
    }
}

fn row_to_channel(row: &sqlx::sqlite::SqliteRow) -> Channel {
    Channel {
        id: row.get("id"),
        name: row.get("name"),
        transport: row.get("transport"),
        preview: row.get("preview"),
        stored_secret: row.get::<i64, _>("stored") != 0,
        enabled: row.get::<i64, _>("enabled") != 0,
        last_error: row.get("last_error"),
        failing_since: row.get("failing_since"),
    }
}

fn row_to_route(row: &sqlx::sqlite::SqliteRow) -> Route {
    Route {
        id: row.get("id"),
        group: row.get("grp"),
        channel_id: row.get("channel_id"),
        min_severity: Severity::parse(&row.get::<String, _>("min_severity")),
        quiet_from: row.get("quiet_from"),
        quiet_to: row.get("quiet_to"),
    }
}

/// A random id. `uuid` is not a dependency here and one function does not justify adding it.
fn uuid() -> String {
    let mut bytes = [0u8; 16];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system has randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const KEY: [u8; 32] = [3u8; 32];
    const URL: &str = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz";

    async fn store() -> (TempDir, ChannelStore) {
        keyed(Some(KEY.to_vec())).await
    }

    async fn keyed(key: Option<Vec<u8>>) -> (TempDir, ChannelStore) {
        let dir = TempDir::new().unwrap();
        let pool = crate::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, ChannelStore::new(pool, key))
    }

    fn input(name: &str, secret: Option<&str>) -> ChannelInput {
        ChannelInput {
            name: name.into(),
            transport: "discord".into(),
            secret: secret.map(str::to_string),
        }
    }

    /// The rule this whole module exists to hold: a stored credential is never handed back.
    #[tokio::test]
    async fn a_credential_never_comes_back_out_of_a_read() {
        let (_dir, store) = store().await;
        let made = store
            .create(&input("money", Some(URL)), 1000)
            .await
            .unwrap();

        for channel in [Some(made.clone()), store.get(&made.id).await.unwrap()]
            .into_iter()
            .flatten()
            .chain(store.list().await.unwrap())
        {
            let rendered = serde_json::to_string(&channel).unwrap();
            assert!(
                !rendered.contains("abcdefghij"),
                "the token appeared in a serialized channel: {rendered}"
            );
            assert!(channel.stored_secret, "but the row should know it has one");
            assert!(
                channel.preview.unwrap().contains("wxyz"),
                "the preview identifies it"
            );
        }

        // And the one door that is allowed to open.
        assert_eq!(
            store.secret_of(&made.id).await.unwrap().as_deref(),
            Some(URL)
        );
    }

    #[tokio::test]
    async fn an_update_without_a_secret_leaves_the_stored_one_alone() {
        // The write-only field means the UI cannot send back a credential it was never given, so
        // "unchanged" has to be expressible as absence. If this regressed, renaming a channel would
        // wipe its webhook.
        let (_dir, store) = store().await;
        let made = store
            .create(&input("money", Some(URL)), 1000)
            .await
            .unwrap();

        let renamed = store
            .update(&made.id, Some("money and fees"), None, None, 2000)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(renamed.name, "money and fees");
        assert_eq!(
            store.secret_of(&made.id).await.unwrap().as_deref(),
            Some(URL)
        );
    }

    #[tokio::test]
    async fn a_new_credential_clears_the_failure_it_probably_fixed() {
        let (_dir, store) = store().await;
        let made = store
            .create(&input("money", Some(URL)), 1000)
            .await
            .unwrap();
        store
            .record_failure(&made.id, "401 unauthorized", 1500)
            .await
            .unwrap();
        assert_eq!(
            store.get(&made.id).await.unwrap().unwrap().failing_since,
            Some(1500)
        );

        let fixed = "https://discord.com/api/webhooks/1234567890/zzzzzzzzzzzzzzzzzzzzzzzz";
        let after = store
            .update(&made.id, None, Some(fixed), None, 2000)
            .await
            .unwrap()
            .unwrap();

        assert!(
            after.last_error.is_none(),
            "a replaced webhook is not still failing"
        );
        assert!(after.failing_since.is_none());
        assert_eq!(
            store.secret_of(&made.id).await.unwrap().as_deref(),
            Some(fixed)
        );
    }

    #[tokio::test]
    async fn without_a_key_a_credential_is_refused_rather_than_stored_in_the_clear() {
        let (_dir, store) = keyed(None).await;

        let refused = store.create(&input("money", Some(URL)), 1000).await;
        let message = refused.unwrap_err().to_string();
        assert!(
            message.contains(secrets::KEY_VAR),
            "the refusal must name the variable to set: {message}"
        );

        // A channel with no credential is still fine — that is how the Telegram row works.
        assert!(store.create(&input("telegram", None), 1000).await.is_ok());
    }

    #[tokio::test]
    async fn destinations_drop_a_disabled_channel_a_low_severity_and_a_quiet_hour() {
        let (_dir, store) = store().await;
        let loud = store
            .create(&input("discord-money", Some(URL)), 1000)
            .await
            .unwrap();
        let off = store
            .create(&input("discord-off", Some(URL)), 1000)
            .await
            .unwrap();
        let quiet = store
            .create(&input("telegram-day", None), 1000)
            .await
            .unwrap();
        store
            .update(&off.id, None, None, Some(false), 1000)
            .await
            .unwrap();

        store
            .set_routes(&[
                Route {
                    id: String::new(),
                    group: "money".into(),
                    channel_id: loud.id.clone(),
                    min_severity: Severity::Warning,
                    quiet_from: None,
                    quiet_to: None,
                },
                Route {
                    id: String::new(),
                    group: "money".into(),
                    channel_id: off.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: None,
                    quiet_to: None,
                },
                Route {
                    id: String::new(),
                    group: "day".into(),
                    channel_id: quiet.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: Some(22),
                    quiet_to: Some(7),
                },
            ])
            .await
            .unwrap();

        // Below the threshold: nothing, even though a disabled channel would have taken info.
        assert!(
            store
                .destinations("money", Severity::Info, 12)
                .await
                .unwrap()
                .is_empty()
        );
        // At it: only the enabled one.
        assert_eq!(
            store
                .destinations("money", Severity::Warning, 12)
                .await
                .unwrap(),
            vec![loud.id.clone()]
        );
        // A group with no route to anything.
        assert!(
            store
                .destinations("system", Severity::Critical, 12)
                .await
                .unwrap()
                .is_empty()
        );
        // Quiet hours, wrapping past midnight.
        assert_eq!(
            store.destinations("day", Severity::Info, 9).await.unwrap(),
            vec![quiet.id.clone()]
        );
        assert!(
            store
                .destinations("day", Severity::Info, 23)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .destinations("day", Severity::Info, 3)
                .await
                .unwrap()
                .is_empty()
        );
        // Critical ignores quiet hours, because a liquidation at 3am is the message you would be
        // angry to have been protected from.
        assert_eq!(
            store
                .destinations("day", Severity::Critical, 3)
                .await
                .unwrap(),
            vec![quiet.id]
        );
    }

    #[tokio::test]
    async fn deleting_a_channel_takes_its_routes_and_nothing_else() {
        let (_dir, store) = store().await;
        let a = store.create(&input("a", Some(URL)), 1000).await.unwrap();
        let b = store.create(&input("b", Some(URL)), 1000).await.unwrap();
        store
            .set_routes(&[
                Route {
                    id: String::new(),
                    group: "money".into(),
                    channel_id: a.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: None,
                    quiet_to: None,
                },
                Route {
                    id: String::new(),
                    group: "money".into(),
                    channel_id: b.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: None,
                    quiet_to: None,
                },
            ])
            .await
            .unwrap();

        assert!(store.delete(&a.id).await.unwrap());
        assert!(
            !store.delete(&a.id).await.unwrap(),
            "deleting twice is not an error, just false"
        );

        let left = store.routes().await.unwrap();
        assert_eq!(
            left.len(),
            1,
            "the cascade took only the deleted channel's route"
        );
        assert_eq!(left[0].channel_id, b.id);
    }

    #[test]
    fn severity_orders_and_an_unknown_one_is_info() {
        assert!(Severity::Critical > Severity::Warning);
        assert!(Severity::Warning > Severity::Info);
        // Not an error: refusing to deliver because a severity was misspelled is worse than
        // delivering it as the quietest level.
        assert_eq!(Severity::parse("nonsense"), Severity::Info);
        assert_eq!(Severity::parse("critical"), Severity::Critical);
    }
}
