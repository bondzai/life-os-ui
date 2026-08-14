//! DefiLlama pricing and the TTL caches in front of it — port of `portfolio.py:244`,
//! `393-408`, `440-502` and `2151`.
//!
//! Three things here decide whether a portfolio total is right:
//!
//! * **A price is optional, and "no price" is cached.** Python stores `None` in the price cache on
//!   failure, so a dead upstream is not re-asked 400 times in one page load. [`TtlCache`] therefore
//!   caches `Option<f64>`, and a *hit* on `None` is still a hit.
//! * **The TTL is short (75s) but real.** Long-running processes otherwise serve a frozen price
//!   until restart. Caches are bounded ([`CACHE_MAX`]) and shed the oldest ~10% on overflow rather
//!   than growing without limit.
//! * **Time is injected.** Every cache read/write takes `now` as a parameter and [`Prices`] holds a
//!   [`Clock`], so expiry and eviction are tested deterministically instead of with `sleep`.
//!
//! All network I/O goes through [`HttpCache`], never `reqwest` directly, so tests replay recorded
//! bytes offline.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::chains::{Chain, NATIVE};
use crate::http_cache::HttpCache;

/// Price / 24h-change entries live this long. Sub-90s is plenty for a net-worth readout.
pub const PRICE_TTL_SECS: f64 = 75.0;
/// Per-cache entry cap; the oldest ~10% are evicted on overflow.
pub const CACHE_MAX: usize = 4096;
/// Daily price history is the "slow" tier — cached an hour (`price_history`).
pub const HISTORY_TTL_SECS: f64 = 3600.0;
/// Longest history DefiLlama is asked for, and the shortest (`max(1, min(days, 3650))`).
pub const HISTORY_MAX_DAYS: u32 = 3650;

pub const LLAMA_PRICES: &str = "https://coins.llama.fi/prices/current";
pub const LLAMA_PERCENTAGE: &str = "https://coins.llama.fi/percentage";
pub const LLAMA_CHART: &str = "https://coins.llama.fi/chart";

// ===========================================================================
// Clock — injected so TTL behaviour is testable without sleeping
// ===========================================================================

/// Wall-clock seconds. The only reason this is a trait: tests must be able to jump 76 seconds
/// forward without taking 76 seconds to do it.
pub trait Clock: std::fmt::Debug + Send + Sync {
    fn now_secs(&self) -> f64;
}

/// The real clock — `time.time()`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    }
}

/// A clock the test drives by hand. Lives outside `#[cfg(test)]` so integration tests and the
/// parity harness can use it too.
#[derive(Debug)]
pub struct ManualClock(Mutex<f64>);

impl ManualClock {
    pub fn new(secs: f64) -> Self {
        Self(Mutex::new(secs))
    }

    pub fn advance(&self, secs: f64) {
        if let Ok(mut now) = self.0.lock() {
            *now += secs;
        }
    }

    pub fn set(&self, secs: f64) {
        if let Ok(mut now) = self.0.lock() {
            *now = secs;
        }
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new(0.0)
    }
}

impl Clock for ManualClock {
    fn now_secs(&self) -> f64 {
        self.0.lock().map(|now| *now).unwrap_or(0.0)
    }
}

// ===========================================================================
// The TTL cache — port of `_tget` / `_tput` / `_ttl`
// ===========================================================================

/// A bounded, time-stamped map: `key -> (stored_at, value)`.
///
/// Deliberately *not* an LRU. Python evicts by insertion time, not by use, so a hot key that was
/// written long ago is dropped just the same; an LRU would keep it and diverge on which entries
/// survive a flood.
#[derive(Debug, Clone)]
pub struct TtlCache<V> {
    entries: HashMap<String, (f64, V)>,
    max: usize,
}

impl<V> Default for TtlCache<V> {
    fn default() -> Self {
        Self::with_capacity(CACHE_MAX)
    }
}

impl<V> TtlCache<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(max: usize) -> Self {
        Self {
            entries: HashMap::new(),
            max: max.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn capacity_limit(&self) -> usize {
        self.max
    }
}

impl<V: Clone> TtlCache<V> {
    /// The value if it was stored less than `ttl` seconds before `now`, else `None`.
    ///
    /// The comparison is `now - stored_at < ttl`, strictly — an entry exactly `ttl` old is stale,
    /// matching `_tget`.
    pub fn get(&self, key: &str, ttl: f64, now: f64) -> Option<V> {
        let (stored_at, value) = self.entries.get(key)?;
        (now - stored_at < ttl).then(|| value.clone())
    }

    /// Store `value` stamped `now`, evicting the oldest ~10% first if the cache is at capacity and
    /// this is a new key. (Overwriting an existing key never evicts — `key not in cache` in Python.)
    pub fn put(&mut self, key: &str, value: V, now: f64) {
        if self.entries.len() >= self.max && !self.entries.contains_key(key) {
            let mut by_age: Vec<(String, f64)> = self
                .entries
                .iter()
                .map(|(k, (stored_at, _))| (k.clone(), *stored_at))
                .collect();
            by_age.sort_by(|a, b| a.1.total_cmp(&b.1));
            for (stale, _) in by_age.into_iter().take(self.max / 10) {
                self.entries.remove(&stale);
            }
        }
        self.entries.insert(key.to_string(), (now, value));
    }
}

/// A cache shared across tasks. `Mutex` rather than `RwLock` because every read may also write.
#[derive(Debug)]
pub struct SharedTtlCache<V>(Mutex<TtlCache<V>>);

impl<V> Default for SharedTtlCache<V> {
    fn default() -> Self {
        Self(Mutex::new(TtlCache::default()))
    }
}

impl<V: Clone> SharedTtlCache<V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// `Some(value)` on a fresh hit. A poisoned lock degrades to a miss rather than a panic: a
    /// cache is an optimisation, and losing it must never take the portfolio down.
    pub fn get(&self, key: &str, ttl: f64, now: f64) -> Option<V> {
        self.0.lock().ok()?.get(key, ttl, now)
    }

    pub fn put(&self, key: &str, value: V, now: f64) {
        if let Ok(mut cache) = self.0.lock() {
            cache.put(key, value, now);
        }
    }

    pub fn len(&self) -> usize {
        self.0.lock().map(|c| c.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ===========================================================================
// Price history
// ===========================================================================

/// One daily close: `d` is epoch **milliseconds**, `v` the USD price. Field names match the JSON
/// the Python emits (`{"d": …, "v": …}`) because the chart front-end reads them directly.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PricePoint {
    pub d: i64,
    pub v: f64,
}

/// Parse a `coins.llama.fi/chart` body into oldest-first daily points.
///
/// Points without a usable price are dropped — Python's `if p.get("price")`, which also discards a
/// literal `0`, so a zero-price day never lands on the chart as a crash to nothing.
pub fn parse_price_history(body: &str, coin: &str) -> Vec<PricePoint> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(points) = value
        .get("coins")
        .and_then(|c| c.get(coin))
        .and_then(|c| c.get("prices"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    points
        .iter()
        .filter_map(|point| {
            let price = as_f64(point.get("price"))?;
            if price == 0.0 {
                return None;
            }
            let timestamp = as_f64(point.get("timestamp"))? as i64;
            Some(PricePoint {
                d: timestamp * 1000,
                v: price,
            })
        })
        .collect()
}

/// A JSON number, or a number carried as a string (DefiLlama is inconsistent about this).
fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// `max(1, min(days, 3650))` — the Python clamp, kept so a caller asking for 0 or 10^6 days gets
/// the same URL from both implementations.
pub fn clamp_history_days(days: u32) -> u32 {
    days.clamp(1, HISTORY_MAX_DAYS)
}

/// The DefiLlama coin key for a token on a chain: `"<llama chain>:<address>"`, with the
/// zero address mapped to the chain's native pseudo-address exactly as `llama_price` does.
///
/// `None` when the chain has no DefiLlama key at all — an unpriceable chain, not a zero price.
pub fn coin_key(chain: &Chain, address: &str) -> Option<String> {
    let llama = chain.llama?;
    Some(format!("{llama}:{}", canonical_address(address)))
}

/// `int(addr, 16) == 0 -> NATIVE`. A v4 pool names its native side as `address(0)`; DefiLlama
/// knows it under the chain's native address instead.
pub fn canonical_address(address: &str) -> String {
    let trimmed = address.trim();
    let digits = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    // A bare `0x` is not a number at all (Python's `int("", 16)` raises), so it is left alone.
    if !digits.is_empty() && digits.chars().all(|c| c == '0') {
        NATIVE.to_string()
    } else {
        address.to_string()
    }
}

// ===========================================================================
// The networked half
// ===========================================================================

/// DefiLlama access with Python's caches in front of it.
///
/// Shared by the spot reader (which seeds the change cache from its batch call, exactly as
/// `_get_spot_uncached` does) and by anything pricing a single token.
#[derive(Debug)]
pub struct Prices {
    client: reqwest::Client,
    cache: HttpCache,
    clock: Arc<dyn Clock>,
    prices: SharedTtlCache<Option<f64>>,
    changes: SharedTtlCache<Option<f64>>,
    history: SharedTtlCache<Vec<PricePoint>>,
}

impl Prices {
    pub fn new(client: reqwest::Client, cache: HttpCache) -> Self {
        Self::with_clock(client, cache, Arc::new(SystemClock))
    }

    pub fn with_clock(client: reqwest::Client, cache: HttpCache, clock: Arc<dyn Clock>) -> Self {
        Self {
            client,
            cache,
            clock,
            prices: SharedTtlCache::new(),
            changes: SharedTtlCache::new(),
            history: SharedTtlCache::new(),
        }
    }

    pub fn now(&self) -> f64 {
        self.clock.now_secs()
    }

    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub(crate) fn http_cache(&self) -> &HttpCache {
        &self.cache
    }

    /// A GET parsed as JSON, `None` on any failure — Python's bare `except` around each call.
    async fn get_json(&self, url: &str) -> Option<Value> {
        let recorded = self.cache.get(&self.client, url).await.ok()?;
        serde_json::from_str(&recorded.body).ok()
    }

    /// Port of `_llama_key_price`: price for a raw key, **uncached**.
    ///
    /// The spot reader calls this for the native coin, and Python does so without touching the
    /// price cache; keeping it uncached matters because the spot result itself is cached for 45s.
    pub async fn llama_key_price(&self, key: &str) -> Option<f64> {
        if key.is_empty() {
            return None;
        }
        let json = self.get_json(&format!("{LLAMA_PRICES}/{key}")).await?;
        as_f64(json.get("coins")?.get(key)?.get("price"))
    }

    /// Port of `llama_price`'s cache layer, by raw key: TTL-cached, and a failed lookup is cached
    /// as `None` so a dead upstream is asked once per window, not once per token.
    pub async fn key_price_cached(&self, key: &str) -> Option<f64> {
        if let Some(hit) = self.prices.get(key, PRICE_TTL_SECS, self.now()) {
            return hit;
        }
        let value = self.llama_key_price(key).await;
        self.prices.put(key, value, self.now());
        value
    }

    /// Port of `llama_price(chain, addr)`.
    pub async fn llama_price(&self, chain: &Chain, address: &str) -> Option<f64> {
        let key = coin_key(chain, address)?;
        self.key_price_cached(&key).await
    }

    /// Port of `_key_change`: 24h % change for a raw coin key, TTL-cached (negatives included).
    pub async fn key_change(&self, key: &str) -> Option<f64> {
        if key.is_empty() {
            return None;
        }
        if let Some(hit) = self.changes.get(key, PRICE_TTL_SECS, self.now()) {
            return hit;
        }
        let value = self
            .get_json(&format!("{LLAMA_PERCENTAGE}/{key}?period=24h"))
            .await
            .and_then(|json| as_f64(json.get("coins")?.get(key)));
        self.changes.put(key, value, self.now());
        value
    }

    /// Port of `llama_change(chain, addr)`.
    pub async fn llama_change(&self, chain: &Chain, address: &str) -> Option<f64> {
        let key = coin_key(chain, address)?;
        self.key_change(&key).await
    }

    /// Seed the change cache from a batch response — `_tput(_change_cache, k, …)` in
    /// `_get_spot_uncached`, so a later single-token lookup is free.
    pub fn seed_change(&self, key: &str, value: Option<f64>) {
        self.changes.put(key, value, self.now());
    }

    /// Read the change cache without fetching. Exists so the spot path can prove it seeded.
    pub fn cached_change(&self, key: &str) -> Option<Option<f64>> {
        self.changes.get(key, PRICE_TTL_SECS, self.now())
    }

    /// Port of `price_history`: daily USD closes, oldest first, cached an hour. `[]` on any miss.
    ///
    /// Unlike the price caches this one does **not** memoise failure: Python's `_ttl` caches
    /// whatever `fetch()` returned, but the caller's `or []` and the empty-list result mean an
    /// empty history is stored — so a transient outage would blank the chart for an hour. It is
    /// stored here only when non-empty, which is the same behaviour for every successful call and
    /// strictly better for a failed one.
    pub async fn price_history(&self, coin: &str, days: u32) -> Vec<PricePoint> {
        let coin = coin.trim();
        if coin.is_empty() {
            return Vec::new();
        }
        let days = clamp_history_days(days);
        let cache_key = format!("pxhist:{coin}:{days}");
        if let Some(hit) = self.history.get(&cache_key, HISTORY_TTL_SECS, self.now()) {
            return hit;
        }
        let url = format!("{LLAMA_CHART}/{coin}?span={days}&period=1d&searchWidth=600");
        let points = match self.cache.get(&self.client, &url).await {
            Ok(recorded) => parse_price_history(&recorded.body, coin),
            Err(error) => {
                tracing::warn!(coin, error = format!("{error:#}"), "price history failed");
                Vec::new()
            }
        };
        if !points.is_empty() {
            self.history.put(&cache_key, points.clone(), self.now());
        }
        points
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains;
    use crate::http_cache::Mode;
    use std::path::PathBuf;

    fn fixtures() -> HttpCache {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        HttpCache::new(dir, Mode::Replay)
    }

    fn prices_at(now: f64) -> (Prices, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(now));
        let prices = Prices::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        (prices, clock)
    }

    // ---------------------------------------------------------------- TTL cache

    #[test]
    fn a_value_inside_the_window_is_a_hit() {
        let mut cache: TtlCache<Option<f64>> = TtlCache::new();
        cache.put("ethereum:0xabc", Some(1234.5), 1_000.0);
        assert_eq!(
            cache.get("ethereum:0xabc", PRICE_TTL_SECS, 1_074.0),
            Some(Some(1234.5)),
            "74s < 75s TTL"
        );
    }

    #[test]
    fn the_window_edge_is_exclusive() {
        let mut cache: TtlCache<Option<f64>> = TtlCache::new();
        cache.put("k", Some(1.0), 0.0);
        assert!(
            cache.get("k", PRICE_TTL_SECS, PRICE_TTL_SECS).is_none(),
            "`now - stored < ttl` is strict, so exactly-TTL-old is stale"
        );
        assert!(
            cache
                .get("k", PRICE_TTL_SECS, PRICE_TTL_SECS - 0.001)
                .is_some()
        );
    }

    #[test]
    fn a_value_past_the_window_is_a_miss() {
        let mut cache: TtlCache<Option<f64>> = TtlCache::new();
        cache.put("k", Some(1.0), 1_000.0);
        assert!(cache.get("k", PRICE_TTL_SECS, 1_076.0).is_none());
    }

    #[test]
    fn a_cached_failure_is_still_a_hit() {
        // The distinction that matters: `None` stored means "asked recently, no price", and must
        // not trigger another upstream call inside the window.
        let mut cache: TtlCache<Option<f64>> = TtlCache::new();
        cache.put("k", None, 10.0);
        assert_eq!(cache.get("k", PRICE_TTL_SECS, 20.0), Some(None));
    }

    #[test]
    fn an_unknown_key_is_a_miss() {
        let cache: TtlCache<Option<f64>> = TtlCache::new();
        assert!(cache.get("nope", PRICE_TTL_SECS, 0.0).is_none());
    }

    #[test]
    fn overflow_evicts_the_oldest_tenth() {
        let mut cache: TtlCache<u32> = TtlCache::with_capacity(100);
        for i in 0..100 {
            cache.put(&format!("k{i}"), i, i as f64); // k0 oldest … k99 newest
        }
        assert_eq!(cache.len(), 100, "at capacity");

        cache.put("new", 999, 1_000.0);
        assert_eq!(
            cache.len(),
            91,
            "10% (10 entries) evicted, then one inserted"
        );
        for i in 0..10 {
            assert!(
                cache
                    .get(&format!("k{i}"), f64::INFINITY, 1_000.0)
                    .is_none(),
                "k{i} was among the oldest 10% and should be gone"
            );
        }
        assert!(
            cache.get("k10", f64::INFINITY, 1_000.0).is_some(),
            "the 11th-oldest survives"
        );
        assert!(cache.get("new", f64::INFINITY, 1_000.0).is_some());
    }

    #[test]
    fn the_default_capacity_matches_python() {
        let cache: TtlCache<u8> = TtlCache::new();
        assert_eq!(cache.capacity_limit(), CACHE_MAX);
        assert_eq!(CACHE_MAX, 4096);
        assert_eq!(CACHE_MAX / 10, 409, "the eviction batch Python computes");
    }

    #[test]
    fn overwriting_an_existing_key_at_capacity_evicts_nothing() {
        // Python guards eviction with `key not in cache`; without it a busy key would shrink the
        // cache by 10% on every refresh.
        let mut cache: TtlCache<u32> = TtlCache::with_capacity(10);
        for i in 0..10 {
            cache.put(&format!("k{i}"), i, i as f64);
        }
        cache.put("k3", 42, 100.0);
        assert_eq!(cache.len(), 10);
        assert_eq!(cache.get("k3", f64::INFINITY, 100.0), Some(42));
    }

    #[test]
    fn eviction_keeps_the_cache_bounded_over_many_inserts() {
        let mut cache: TtlCache<u32> = TtlCache::with_capacity(50);
        for i in 0..500 {
            cache.put(&format!("k{i}"), i, i as f64);
        }
        assert!(
            cache.len() <= 50,
            "never exceeds the cap, got {}",
            cache.len()
        );
    }

    #[test]
    fn the_shared_cache_is_usable_from_a_reference() {
        let cache: SharedTtlCache<Option<f64>> = SharedTtlCache::new();
        cache.put("k", Some(2.0), 0.0);
        assert_eq!(cache.get("k", PRICE_TTL_SECS, 10.0), Some(Some(2.0)));
        assert!(cache.get("k", PRICE_TTL_SECS, 100.0).is_none());
    }

    // ---------------------------------------------------------------- clock

    #[test]
    fn the_manual_clock_only_moves_when_told_to() {
        let clock = ManualClock::new(500.0);
        assert_eq!(clock.now_secs(), 500.0);
        clock.advance(76.0);
        assert_eq!(clock.now_secs(), 576.0);
    }

    #[test]
    fn the_system_clock_is_after_2020() {
        assert!(SystemClock.now_secs() > 1_577_836_800.0);
    }

    // ---------------------------------------------------------------- history parsing

    #[test]
    fn history_points_become_epoch_millis_oldest_first() {
        let body = r#"{"coins":{"coingecko:bitcoin":{"symbol":"BTC","confidence":0.99,
            "prices":[{"timestamp":1700000000,"price":37000.5},
                      {"timestamp":1700086400,"price":37500.25}]}}}"#;
        assert_eq!(
            parse_price_history(body, "coingecko:bitcoin"),
            vec![
                PricePoint {
                    d: 1_700_000_000_000,
                    v: 37000.5
                },
                PricePoint {
                    d: 1_700_086_400_000,
                    v: 37500.25
                },
            ]
        );
    }

    #[test]
    fn priceless_and_zero_points_are_dropped() {
        let body = r#"{"coins":{"c":{"prices":[
            {"timestamp":1,"price":0},
            {"timestamp":2},
            {"timestamp":3,"price":null},
            {"timestamp":4,"price":1.5}]}}}"#;
        assert_eq!(
            parse_price_history(body, "c"),
            vec![PricePoint { d: 4000, v: 1.5 }],
            "Python's `if p.get('price')` drops 0, missing and null alike"
        );
    }

    #[test]
    fn a_body_for_a_different_coin_is_empty() {
        let body = r#"{"coins":{"coingecko:bitcoin":{"prices":[{"timestamp":1,"price":2}]}}}"#;
        assert!(parse_price_history(body, "coingecko:ethereum").is_empty());
    }

    #[test]
    fn junk_bodies_are_empty_not_panics() {
        assert!(parse_price_history("<html>502</html>", "c").is_empty());
        assert!(parse_price_history("{}", "c").is_empty());
        assert!(parse_price_history(r#"{"coins":{"c":{}}}"#, "c").is_empty());
    }

    #[test]
    fn history_days_are_clamped_like_python() {
        assert_eq!(clamp_history_days(0), 1);
        assert_eq!(clamp_history_days(365), 365);
        assert_eq!(clamp_history_days(99_999), 3650);
    }

    // ---------------------------------------------------------------- keys

    #[test]
    fn a_coin_key_is_chain_prefixed() {
        let base = chains::by_name("base").unwrap();
        assert_eq!(
            coin_key(base, "0xUSDC").as_deref(),
            Some("base:0xUSDC"),
            "the address is passed through verbatim, casing included"
        );
    }

    #[test]
    fn the_zero_address_maps_to_the_native_pseudo_address() {
        let base = chains::by_name("base").unwrap();
        let expected = format!("base:{NATIVE}");
        assert_eq!(
            coin_key(base, "0x0000000000000000000000000000000000000000"),
            Some(expected)
        );
        assert_eq!(
            canonical_address("0x0"),
            NATIVE,
            "any all-zero hex, any width"
        );
    }

    #[test]
    fn a_chain_without_a_llama_key_has_no_coin_key() {
        let bitcoin = chains::by_name("bitcoin").unwrap();
        assert!(
            bitcoin.llama.is_none() == coin_key(bitcoin, "0xabc").is_none(),
            "a missing DefiLlama chain key means no coin key at all"
        );
    }

    // ---------------------------------------------------------------- cache wiring

    #[tokio::test]
    async fn a_seeded_change_is_served_without_a_fetch() {
        // The cache is pointed at replay with no fixture for this key: if the seed were ignored,
        // the call would fail rather than return the seeded value.
        let (prices, clock) = prices_at(1_000.0);
        prices.seed_change("base:0xdead", Some(-4.25));
        assert_eq!(prices.key_change("base:0xdead").await, Some(-4.25));

        clock.advance(PRICE_TTL_SECS + 1.0);
        assert_eq!(
            prices.cached_change("base:0xdead"),
            None,
            "past the window the seed is gone and a real fetch would be needed"
        );
    }

    #[tokio::test]
    async fn an_empty_key_never_hits_the_network() {
        let (prices, _clock) = prices_at(0.0);
        assert_eq!(prices.llama_key_price("").await, None);
        assert_eq!(prices.key_change("").await, None);
        assert!(prices.price_history("   ", 30).await.is_empty());
    }
}
