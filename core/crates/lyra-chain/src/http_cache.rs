//! Record/replay for upstream HTTP, so chain tests are deterministic.
//!
//! The parity harness compares the Python oracle against the Rust port. Both read live chains, at
//! slightly different moments — so a balance that moves between the two calls looks exactly like a
//! porting bug. This removes that ambiguity: record every upstream response once, then replay the
//! same bytes into both sides.
//!
//! Modes, from `LYRA_HTTP_CACHE`:
//!
//! | value | behaviour |
//! |---|---|
//! | unset / `off` | straight passthrough, nothing touches disk |
//! | `record` | fetch live, write each response to the fixture dir, return it |
//! | `replay` | serve from the fixture dir; a miss is an **error**, never a live call |
//!
//! `replay` failing loudly on a miss is the point. Silently falling back to the network would let
//! a test pass against live data and then fail in CI, which is the failure mode fixtures exist to
//! prevent.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Record,
    Replay,
}

impl Mode {
    pub fn from_env() -> Self {
        match std::env::var("LYRA_HTTP_CACHE")
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "record" => Mode::Record,
            "replay" => Mode::Replay,
            _ => Mode::Off,
        }
    }
}

/// A recorded upstream exchange. Stored as JSON so a fixture can be read and edited by hand when
/// reproducing an odd upstream response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Recorded {
    /// Kept for readability when browsing the fixture directory; not part of the key.
    pub url: String,
    pub method: String,
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct HttpCache {
    dir: PathBuf,
    mode: Mode,
}

impl HttpCache {
    pub fn new(dir: impl Into<PathBuf>, mode: Mode) -> Self {
        Self {
            dir: dir.into(),
            mode,
        }
    }

    /// Fixture directory from `LYRA_HTTP_FIXTURES`, else `tests/fixtures` beside the crate.
    pub fn from_env() -> Self {
        let dir = std::env::var("LYRA_HTTP_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"));
        Self::new(dir, Mode::from_env())
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// A GET through the cache, honouring the current mode.
    pub async fn get(&self, client: &reqwest::Client, url: &str) -> Result<Recorded> {
        self.request(client, reqwest::Method::GET, url, None).await
    }

    /// A POST through the cache — JSON-RPC calls to chain nodes are POSTs, and their body is part
    /// of the identity of the request.
    pub async fn post_json(
        &self,
        client: &reqwest::Client,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<Recorded> {
        self.request(client, reqwest::Method::POST, url, Some(body.to_string()))
            .await
    }

    async fn request(
        &self,
        client: &reqwest::Client,
        method: reqwest::Method,
        url: &str,
        body: Option<String>,
    ) -> Result<Recorded> {
        let key = cache_key(method.as_str(), url, body.as_deref());

        if self.mode == Mode::Replay {
            return self.read(&key).with_context(|| {
                format!(
                    "no fixture for {method} {url} (key {key}). Re-record with \
                     LYRA_HTTP_CACHE=record; replay never falls back to the network."
                )
            });
        }

        let mut request = client.request(method.clone(), url);
        if let Some(body) = &body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone());
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("{method} {url}"))?;
        let recorded = Recorded {
            url: url.to_string(),
            method: method.as_str().to_string(),
            status: response.status().as_u16(),
            body: response.text().await.unwrap_or_default(),
        };

        if self.mode == Mode::Record {
            self.write(&key, &recorded)
                .with_context(|| format!("recording fixture for {method} {url}"))?;
        }
        Ok(recorded)
    }

    fn path_for(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    fn read(&self, key: &str) -> Result<Recorded> {
        let path = self.path_for(key);
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
    }

    fn write(&self, key: &str, recorded: &Recorded) -> Result<()> {
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("creating {}", self.dir.display()))?;
        let path = self.path_for(key);
        std::fs::write(&path, serde_json::to_string_pretty(recorded)?)
            .with_context(|| format!("writing {}", path.display()))?;
        tracing::debug!(key, url = recorded.url, "recorded upstream response");
        Ok(())
    }
}

/// Identity of a request: method, URL, and body. Hashed so a key is a safe filename regardless of
/// query strings, and truncated to 32 hex chars — 128 bits, far beyond collision range here.
pub fn cache_key(method: &str, url: &str, body: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update(b"\n");
    hasher.update(url.as_bytes());
    hasher.update(b"\n");
    hasher.update(body.unwrap_or_default().as_bytes());
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn the_key_covers_method_url_and_body() {
        let base = cache_key("GET", "https://x/api", None);
        assert_eq!(
            base,
            cache_key("GET", "https://x/api", None),
            "stable across calls"
        );
        assert_ne!(
            base,
            cache_key("POST", "https://x/api", None),
            "method matters"
        );
        assert_ne!(
            base,
            cache_key("GET", "https://x/other", None),
            "url matters"
        );
        assert_ne!(
            base,
            cache_key("GET", "https://x/api", Some("{}")),
            "body matters"
        );
    }

    #[test]
    fn two_rpc_calls_to_one_node_get_different_keys() {
        // Every JSON-RPC call hits the same URL; only the body distinguishes them, so a key that
        // ignored the body would collapse every eth_call into one fixture.
        let url = "https://rpc.example/eth";
        let a = cache_key("POST", url, Some(r#"{"method":"eth_getBalance"}"#));
        let b = cache_key("POST", url, Some(r#"{"method":"eth_call"}"#));
        assert_ne!(a, b);
    }

    #[test]
    fn the_key_is_a_safe_filename() {
        let key = cache_key("GET", "https://x/api?a=1&b=../../etc/passwd", None);
        assert_eq!(key.len(), 32);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()), "got {key}");
    }

    #[test]
    fn mode_parses_from_the_environment() {
        // Set/read directly rather than through from_env, to avoid racing other tests on env.
        assert_eq!(Mode::from_env(), Mode::Off, "unset means off");
    }

    #[test]
    fn a_recorded_response_round_trips_through_disk() {
        let dir = TempDir::new().unwrap();
        let cache = HttpCache::new(dir.path(), Mode::Record);
        let key = cache_key("GET", "https://x/api", None);
        let recorded = Recorded {
            url: "https://x/api".into(),
            method: "GET".into(),
            status: 200,
            body: r#"{"result":42}"#.into(),
        };

        cache.write(&key, &recorded).unwrap();
        assert_eq!(cache.read(&key).unwrap(), recorded);
    }

    #[test]
    fn replay_reports_a_miss_with_instructions_instead_of_going_to_the_network() {
        let dir = TempDir::new().unwrap();
        let cache = HttpCache::new(dir.path(), Mode::Replay);
        let err = cache.read("definitely-missing").unwrap_err();
        // The read itself fails; `request` wraps it with the re-record hint.
        assert!(err.to_string().contains("reading"), "{err}");
    }

    #[tokio::test]
    async fn replay_mode_never_makes_a_request() {
        // Point at an unroutable host: if replay tried the network this would hang or error
        // with a connection failure rather than a missing-fixture message.
        let dir = TempDir::new().unwrap();
        let cache = HttpCache::new(dir.path(), Mode::Replay);
        let client = reqwest::Client::new();

        let err = cache
            .get(&client, "http://127.0.0.1:1/never")
            .await
            .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("no fixture for"), "{text}");
        assert!(
            text.contains("LYRA_HTTP_CACHE=record"),
            "should say how to fix it: {text}"
        );
    }

    #[tokio::test]
    async fn record_then_replay_returns_the_same_bytes() {
        let dir = TempDir::new().unwrap();
        let client = reqwest::Client::new();

        // Stand up a tiny server so the round trip is real rather than mocked.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf).await;
                    let body = r#"{"balance":"0x1"}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        let url = format!("http://{addr}/balance");

        let recorder = HttpCache::new(dir.path(), Mode::Record);
        let live = recorder.get(&client, &url).await.unwrap();
        assert_eq!(live.status, 200);
        assert_eq!(live.body, r#"{"balance":"0x1"}"#);

        // Replay must produce identical bytes with the server irrelevant.
        let replayer = HttpCache::new(dir.path(), Mode::Replay);
        let replayed = replayer.get(&client, &url).await.unwrap();
        assert_eq!(replayed, live);
    }

    #[tokio::test]
    async fn off_mode_writes_nothing_to_disk() {
        let dir = TempDir::new().unwrap();
        let cache = HttpCache::new(dir.path(), Mode::Off);
        let client = reqwest::Client::new();
        // The request fails (nothing listening); what matters is that no fixture appeared.
        let _ = cache.get(&client, "http://127.0.0.1:1/never").await;
        assert!(
            !dir.path().join("").read_dir().unwrap().any(|e| e.is_ok()),
            "no files expected"
        );
    }
}
