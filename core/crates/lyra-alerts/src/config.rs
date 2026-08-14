//! Alert configuration — port of `notify.py:76-200`.
//!
//! Two layers, and the order between them is the whole point: a value saved from the Settings UI
//! **wins over** the matching environment variable, and clearing it (sending `null`) reverts to the
//! env. That is what lets the schedule be tuned without editing `.env.local` and rebuilding.
//!
//! Every accessor here is a *validated* read, not a plain lookup, and the validation is
//! deliberately inconsistent between keys because the Python's is. Three examples worth knowing
//! before "tidying" any of it:
//!
//! * a malformed `ALERT_INTERVAL` **raises** (the poller refuses to start on a typo), while a
//!   malformed `SNAPSHOT_INTERVAL` silently falls back to its default;
//! * a malformed `ALERT_HF` falls back to the default `1.5` — *on*, not off — because failing open
//!   on a liquidation alarm is the dangerous direction;
//! * `digest_hour` saved as the string `"9"` means **off**, not 9am, because the save path only
//!   accepts a number there.
//!
//! Reading env through [`EnvSource`] rather than `std::env` keeps the accessors pure: tests set a
//! map instead of a process-global, so they can run in parallel without racing each other.

use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};

/// The keys the UI may override, validated on save — `_CFG_KEYS`.
pub const CFG_KEYS: [&str; 5] = [
    "interval",
    "digest_hour",
    "fee_usd",
    "report_ccy",
    "hf_alert",
];

/// Currencies the brief can render in, and their symbol — `_CCY_SYM`.
pub const CURRENCIES: [(&str, &str); 2] = [("usd", "$"), ("thb", "฿")];

/// `_DEFAULT_CCY`. THB, not USD: the reader lives in Thailand.
pub const DEFAULT_CCY: &str = "thb";

/// Floor on the poll interval — 60s, to stop a UI typo hammering upstream APIs.
pub const MIN_INTERVAL: u64 = 60;
/// Default poll interval when nothing is configured (15 minutes).
pub const DEFAULT_INTERVAL: u64 = 900;
/// Floor and default for the net-worth snapshot cadence.
pub const MIN_SNAPSHOT_INTERVAL: u64 = 300;
pub const DEFAULT_SNAPSHOT_INTERVAL: u64 = 3600;
/// Default health-factor floor. Applied when `ALERT_HF` is unset *or* unparseable.
pub const DEFAULT_HF: f64 = 1.5;

/// Whether a currency code is one the brief can render.
pub fn is_known_currency(code: &str) -> bool {
    CURRENCIES.iter().any(|(c, _)| *c == code)
}

/// Symbol for a currency code, e.g. `"thb"` -> `"฿"`.
pub fn currency_symbol(code: &str) -> Option<&'static str> {
    CURRENCIES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, symbol)| *symbol)
}

// ===========================================================================
// Environment
// ===========================================================================

/// Where the env-var half of the config comes from.
///
/// An indirection on purpose: `std::env` is process-global, so accessor tests that set real
/// variables race each other under the test harness's threads. Tests use [`MapEnv`].
pub trait EnvSource {
    fn get(&self, key: &str) -> Option<String>;
}

/// The real process environment.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// A fixed environment, for tests and for replaying a recorded configuration.
#[derive(Debug, Clone, Default)]
pub struct MapEnv(HashMap<String, String>);

impl MapEnv {
    pub fn new<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self(
            vars.into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        )
    }
}

impl EnvSource for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned()
    }
}

// ===========================================================================
// Saved overrides
// ===========================================================================

/// The UI-saved override map — the content of `_CFG_FILE`, minus the file.
///
/// Only [`CFG_KEYS`] survive a load, so an unrecognised key someone hand-wrote into storage cannot
/// reach the accessors.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Overrides(Map<String, Value>);

impl Overrides {
    pub fn new() -> Self {
        Self::default()
    }

    /// Port of `load_cfg`: keep the recognised keys, and treat *anything* unreadable — missing
    /// storage, corrupt JSON, a JSON array where an object was expected — as "no overrides".
    /// Config being unreadable must never stop the poller; it just reverts to env defaults.
    pub fn from_json(value: &Value) -> Self {
        let Some(object) = value.as_object() else {
            return Self::default();
        };
        Self(
            CFG_KEYS
                .iter()
                .filter_map(|key| object.get_key_value(*key))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        )
    }

    pub fn as_json(&self) -> Value {
        Value::Object(self.0.clone())
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Port of `save_cfg`: merge a partial patch from the UI, validating per key.
    ///
    /// A key set to `null` is **removed**, which is how the UI reverts a knob to its env value —
    /// distinct from setting it to 0, which means "off". Keys absent from the patch are untouched.
    ///
    /// Errors on a value that cannot be coerced (`interval: "abc"`), matching the Python, whose
    /// `int()`/`float()` raise outside its try block. The caller reports the failure instead of
    /// silently persisting a nonsense schedule.
    pub fn merge_patch(&mut self, patch: &Value) -> Result<()> {
        let Some(object) = patch.as_object() else {
            bail!("config patch must be a JSON object");
        };
        for key in CFG_KEYS {
            let Some(value) = object.get(key) else {
                continue;
            };
            if value.is_null() {
                self.0.remove(key);
                continue;
            }
            let coerced = match key {
                "interval" => {
                    let seconds = to_int(value).with_context(|| format!("config {key}"))?;
                    Value::from(seconds.max(MIN_INTERVAL as i64))
                }
                // Note the asymmetry: only a *number* is accepted. A string "9" is not an hour,
                // it is a mistake, and the Python records -1 (off) rather than guessing.
                "digest_hour" => match value.as_f64() {
                    Some(hour) if (0.0..=23.0).contains(&hour) && !value.is_boolean() => {
                        Value::from(hour.trunc() as i64)
                    }
                    _ => Value::from(-1),
                },
                "fee_usd" | "hf_alert" => {
                    let amount = to_float(value).with_context(|| format!("config {key}"))?;
                    Value::from(amount.max(0.0))
                }
                "report_ccy" => {
                    let code = as_lossy_string(value).to_lowercase();
                    Value::from(if is_known_currency(&code) {
                        code
                    } else {
                        DEFAULT_CCY.to_string()
                    })
                }
                _ => unreachable!("CFG_KEYS and this match must stay in step"),
            };
            self.0.insert(key.to_string(), coerced);
        }
        Ok(())
    }
}

/// Python's `int(v)`: a JSON integer, a float truncated toward zero, or a numeric string.
fn to_int(value: &Value) -> Result<i64> {
    match value {
        Value::Number(n) => n
            .as_f64()
            .map(|f| f.trunc() as i64)
            .context("not an integer"),
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .with_context(|| format!("not an integer: {s:?}")),
        other => bail!("not an integer: {other}"),
    }
}

/// Python's `float(v)`: a JSON number or a numeric string.
fn to_float(value: &Value) -> Result<f64> {
    match value {
        Value::Number(n) => n.as_f64().context("not a number"),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .with_context(|| format!("not a number: {s:?}")),
        other => bail!("not a number: {other}"),
    }
}

/// Python's `str(v)` for the currency check — a bare string stays as-is, anything else renders.
fn as_lossy_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// ===========================================================================
// Accessors
// ===========================================================================

/// A resolved view over overrides + environment. Cheap to build; build one per sweep so a UI save
/// takes effect without a restart, exactly as the Python re-reads on every call.
pub struct AlertConfig<'a> {
    pub overrides: &'a Overrides,
    pub env: &'a dyn EnvSource,
}

impl<'a> AlertConfig<'a> {
    pub fn new(overrides: &'a Overrides, env: &'a dyn EnvSource) -> Self {
        Self { overrides, env }
    }

    /// Seconds between sweeps — `_interval`.
    ///
    /// **Errors** on an unparseable `ALERT_INTERVAL`, because the Python's `int()` is outside any
    /// try block: a typo stops the poller rather than quietly running on a schedule nobody chose.
    /// An override is honoured only when it is an integer ≥ 60; anything else falls through to env.
    pub fn interval(&self) -> Result<u64> {
        if let Some(value) = self.overrides.get("interval")
            && let Some(seconds) = value.as_i64()
            && seconds >= MIN_INTERVAL as i64
        {
            return Ok(seconds as u64);
        }
        let raw = self.env_or_empty("ALERT_INTERVAL");
        let seconds = if raw.is_empty() {
            DEFAULT_INTERVAL as i64
        } else {
            raw.trim()
                .parse::<i64>()
                .with_context(|| format!("ALERT_INTERVAL is not an integer: {raw:?}"))?
        };
        Ok((seconds.max(MIN_INTERVAL as i64)) as u64)
    }

    /// Seconds between recorded net-worth snapshots — `_snapshot_interval`.
    ///
    /// Unlike [`Self::interval`], a malformed value here is **caught** and the default used: the
    /// Python wraps this one in `try/except ValueError`. Preserved as-is; the difference is real.
    pub fn snapshot_interval(&self) -> u64 {
        let raw = self.env_or_empty("SNAPSHOT_INTERVAL");
        let seconds = if raw.is_empty() {
            DEFAULT_SNAPSHOT_INTERVAL as i64
        } else {
            match raw.trim().parse::<i64>() {
                Ok(seconds) => seconds,
                Err(_) => return DEFAULT_SNAPSHOT_INTERVAL,
            }
        };
        seconds.max(MIN_SNAPSHOT_INTERVAL as i64) as u64
    }

    /// Hour of day (0-23, local) for the daily brief, or `None` when it is off — `_digest_hour`.
    ///
    /// A saved `-1` is the UI's "off" switch, and an out-of-range or non-integer saved value reads
    /// as off too rather than falling through to env: once the user has touched the knob, their
    /// setting decides.
    pub fn digest_hour(&self) -> Option<u32> {
        if let Some(value) = self.overrides.get("digest_hour") {
            let hour = value.as_i64()?;
            return (0..=23).contains(&hour).then_some(hour as u32);
        }
        let raw = self.env_or_empty("DIGEST_HOUR");
        let hour = raw.trim().parse::<i64>().ok()?;
        (0..=23).contains(&hour).then_some(hour as u32)
    }

    /// Unclaimed-fee threshold in USD, or `None` when the ping is off — `_fee_threshold`.
    ///
    /// Zero and negative both mean off; a malformed env means off. Failing *closed* is right here:
    /// a missed "fees ready" ping costs nothing but a later claim.
    pub fn fee_threshold(&self) -> Option<f64> {
        if let Some(value) = self.overrides.get("fee_usd") {
            return value.as_f64().filter(|amount| *amount > 0.0);
        }
        let raw = self.env_or_empty("ALERT_FEE_USD");
        if raw.is_empty() {
            return None;
        }
        raw.trim()
            .parse::<f64>()
            .ok()
            .filter(|amount| *amount > 0.0)
    }

    /// Health-factor floor to ping below, or `None` when off — `_hf_threshold`.
    ///
    /// The one accessor that fails **open**: an unparseable `ALERT_HF` yields the 1.5 default
    /// rather than `None`, so a typo cannot silently disable the liquidation alarm. An explicit 0
    /// still turns it off — that is a choice, not a typo.
    pub fn hf_threshold(&self) -> Option<f64> {
        if let Some(value) = self.overrides.get("hf_alert") {
            return value.as_f64().filter(|floor| *floor > 0.0);
        }
        let raw = self.env_or_empty("ALERT_HF");
        if raw.is_empty() {
            return Some(DEFAULT_HF);
        }
        match raw.trim().parse::<f64>() {
            Ok(floor) => (floor > 0.0).then_some(floor),
            Err(_) => Some(DEFAULT_HF),
        }
    }

    /// Currency every figure in the brief renders in — `_report_ccy`. Always a known code.
    pub fn report_ccy(&self) -> String {
        let saved = self
            .overrides
            .get("report_ccy")
            .map(as_lossy_string)
            .filter(|code| !code.is_empty());
        let code = saved
            .or_else(|| {
                let from_env = self.env_or_empty("ALERT_REPORT_CCY");
                (!from_env.is_empty()).then_some(from_env)
            })
            .unwrap_or_else(|| DEFAULT_CCY.to_string())
            .to_lowercase();

        if is_known_currency(&code) {
            code
        } else {
            DEFAULT_CCY.to_string()
        }
    }

    /// Python reads env as `os.environ.get(k, "")`, where an empty value means "unset".
    fn env_or_empty(&self, key: &str) -> String {
        self.env.get(key).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn empty_env() -> MapEnv {
        MapEnv::default()
    }

    fn config<'a>(overrides: &'a Overrides, env: &'a MapEnv) -> AlertConfig<'a> {
        AlertConfig::new(overrides, env)
    }

    fn saved(patch: Value) -> Overrides {
        let mut overrides = Overrides::new();
        overrides.merge_patch(&patch).expect("valid patch");
        overrides
    }

    // --- load / save --------------------------------------------------------

    #[test]
    fn loading_keeps_only_the_recognised_keys() {
        let stored = json!({"interval": 600, "digest_hour": 9, "nonsense": 1, "token": "secret"});
        let overrides = Overrides::from_json(&stored);
        assert_eq!(overrides.get("interval"), Some(&json!(600)));
        assert_eq!(overrides.get("digest_hour"), Some(&json!(9)));
        assert_eq!(overrides.get("nonsense"), None, "unknown keys are dropped");
        assert_eq!(overrides.get("token"), None);
    }

    #[test]
    fn unreadable_config_is_no_config_rather_than_an_error() {
        // The Python swallows every exception here; config must never stop the poller.
        assert!(Overrides::from_json(&json!(null)).is_empty());
        assert!(Overrides::from_json(&json!([1, 2, 3])).is_empty());
        assert!(Overrides::from_json(&json!("garbage")).is_empty());
    }

    #[test]
    fn a_patch_merges_rather_than_replaces() {
        let mut overrides = saved(json!({"interval": 600, "fee_usd": 25}));
        overrides.merge_patch(&json!({"fee_usd": 50})).unwrap();
        assert_eq!(overrides.get("interval"), Some(&json!(600)), "untouched");
        assert_eq!(overrides.get("fee_usd"), Some(&json!(50.0)));
    }

    #[test]
    fn null_removes_a_key_so_it_reverts_to_env() {
        // The distinction that matters: null = "use the env value", 0 = "off".
        let mut overrides = saved(json!({"fee_usd": 25}));
        overrides.merge_patch(&json!({"fee_usd": null})).unwrap();
        assert_eq!(overrides.get("fee_usd"), None);

        let env = MapEnv::new([("ALERT_FEE_USD", "10")]);
        assert_eq!(config(&overrides, &env).fee_threshold(), Some(10.0));
    }

    #[test]
    fn zero_is_off_and_is_not_the_same_as_absent() {
        let overrides = saved(json!({"fee_usd": 0, "hf_alert": 0}));
        let env = MapEnv::new([("ALERT_FEE_USD", "10"), ("ALERT_HF", "2.0")]);
        let config = config(&overrides, &env);
        assert_eq!(
            config.fee_threshold(),
            None,
            "0 means off, env must not win"
        );
        assert_eq!(config.hf_threshold(), None);
    }

    #[test]
    fn the_interval_floor_is_applied_on_save() {
        assert_eq!(
            saved(json!({"interval": 5})).get("interval"),
            Some(&json!(60))
        );
        assert_eq!(
            saved(json!({"interval": 900})).get("interval"),
            Some(&json!(900))
        );
    }

    #[test]
    fn negative_amounts_are_clamped_to_zero_on_save() {
        assert_eq!(
            saved(json!({"fee_usd": -5})).get("fee_usd"),
            Some(&json!(0.0))
        );
        assert_eq!(
            saved(json!({"hf_alert": -1.5})).get("hf_alert"),
            Some(&json!(0.0))
        );
    }

    #[test]
    fn a_saved_digest_hour_string_means_off_not_nine_am() {
        // Python only accepts int/float here, so "9" records -1 (off). Surprising, preserved.
        assert_eq!(
            saved(json!({"digest_hour": "9"})).get("digest_hour"),
            Some(&json!(-1))
        );
        let overrides = saved(json!({"digest_hour": "9"}));
        let env = MapEnv::new([("DIGEST_HOUR", "7")]);
        assert_eq!(
            config(&overrides, &env).digest_hour(),
            None,
            "and it stays off rather than falling back to env"
        );
    }

    #[test]
    fn an_out_of_range_digest_hour_is_recorded_as_off() {
        assert_eq!(
            saved(json!({"digest_hour": 24})).get("digest_hour"),
            Some(&json!(-1))
        );
        assert_eq!(
            saved(json!({"digest_hour": -3})).get("digest_hour"),
            Some(&json!(-1))
        );
        assert_eq!(
            saved(json!({"digest_hour": 0})).get("digest_hour"),
            Some(&json!(0)),
            "midnight is a valid hour"
        );
        assert_eq!(
            saved(json!({"digest_hour": 23})).get("digest_hour"),
            Some(&json!(23))
        );
    }

    #[test]
    fn a_float_digest_hour_truncates_like_python_int() {
        assert_eq!(
            saved(json!({"digest_hour": 9.7})).get("digest_hour"),
            Some(&json!(9))
        );
    }

    #[test]
    fn numeric_strings_are_accepted_where_python_coerces_them() {
        assert_eq!(
            saved(json!({"interval": "600"})).get("interval"),
            Some(&json!(600))
        );
        assert_eq!(
            saved(json!({"fee_usd": "25.5"})).get("fee_usd"),
            Some(&json!(25.5))
        );
    }

    #[test]
    fn a_junk_amount_fails_the_save_instead_of_persisting_nonsense() {
        // Python's int()/float() raise here — outside its try — so the save reports failure.
        let mut overrides = Overrides::new();
        assert!(overrides.merge_patch(&json!({"interval": "abc"})).is_err());
        assert!(overrides.merge_patch(&json!({"fee_usd": "lots"})).is_err());
        assert!(overrides.merge_patch(&json!({"hf_alert": []})).is_err());
        assert!(overrides.merge_patch(&json!({"interval": "9.5"})).is_err());
    }

    #[test]
    fn an_unknown_currency_saves_as_the_default() {
        assert_eq!(
            saved(json!({"report_ccy": "eur"})).get("report_ccy"),
            Some(&json!("thb"))
        );
        assert_eq!(
            saved(json!({"report_ccy": "USD"})).get("report_ccy"),
            Some(&json!("usd")),
            "case is normalised"
        );
        assert_eq!(
            saved(json!({"report_ccy": 5})).get("report_ccy"),
            Some(&json!("thb"))
        );
    }

    #[test]
    fn keys_absent_from_the_patch_are_left_alone() {
        let mut overrides = saved(json!({"interval": 600}));
        overrides.merge_patch(&json!({})).unwrap();
        assert_eq!(overrides.get("interval"), Some(&json!(600)));
    }

    // --- interval -----------------------------------------------------------

    #[test]
    fn interval_defaults_to_fifteen_minutes() {
        assert_eq!(
            config(&Overrides::new(), &empty_env()).interval().unwrap(),
            900
        );
    }

    #[test]
    fn interval_reads_env_then_override() {
        let env = MapEnv::new([("ALERT_INTERVAL", "300")]);
        assert_eq!(config(&Overrides::new(), &env).interval().unwrap(), 300);

        let overrides = saved(json!({"interval": 120}));
        assert_eq!(
            config(&overrides, &env).interval().unwrap(),
            120,
            "the saved value wins over env"
        );
    }

    #[test]
    fn interval_is_floored_at_sixty_seconds() {
        let env = MapEnv::new([("ALERT_INTERVAL", "5")]);
        assert_eq!(config(&Overrides::new(), &env).interval().unwrap(), 60);
    }

    #[test]
    fn a_sub_minimum_override_falls_through_to_env() {
        // isinstance(v, int) and v >= 60 — a hand-edited 30 is ignored, not clamped.
        let overrides = Overrides::from_json(&json!({"interval": 30}));
        let env = MapEnv::new([("ALERT_INTERVAL", "300")]);
        assert_eq!(config(&overrides, &env).interval().unwrap(), 300);
    }

    #[test]
    fn a_float_interval_override_is_ignored_like_pythons_isinstance_check() {
        // isinstance(900.0, int) is False in Python, so a float override falls through to env.
        let overrides = Overrides::from_json(&json!({"interval": 900.5}));
        let env = MapEnv::new([("ALERT_INTERVAL", "300")]);
        assert_eq!(config(&overrides, &env).interval().unwrap(), 300);
    }

    #[test]
    fn an_empty_interval_env_means_the_default() {
        let env = MapEnv::new([("ALERT_INTERVAL", "")]);
        assert_eq!(config(&Overrides::new(), &env).interval().unwrap(), 900);
    }

    #[test]
    fn a_malformed_interval_env_is_an_error_not_a_default() {
        // Python raises here. A typo must stop the poller, not silently reschedule it.
        let env = MapEnv::new([("ALERT_INTERVAL", "every 5 minutes")]);
        assert!(config(&Overrides::new(), &env).interval().is_err());
    }

    // --- snapshot interval --------------------------------------------------

    #[test]
    fn snapshot_interval_defaults_to_an_hour_with_a_five_minute_floor() {
        assert_eq!(
            config(&Overrides::new(), &empty_env()).snapshot_interval(),
            3600
        );
        let env = MapEnv::new([("SNAPSHOT_INTERVAL", "60")]);
        assert_eq!(config(&Overrides::new(), &env).snapshot_interval(), 300);
    }

    #[test]
    fn a_malformed_snapshot_interval_falls_back_instead_of_erroring() {
        // The asymmetry with ALERT_INTERVAL is real: this one is inside a try/except.
        let env = MapEnv::new([("SNAPSHOT_INTERVAL", "hourly")]);
        assert_eq!(config(&Overrides::new(), &env).snapshot_interval(), 3600);
    }

    // --- digest hour --------------------------------------------------------

    #[test]
    fn the_digest_is_off_by_default() {
        assert_eq!(config(&Overrides::new(), &empty_env()).digest_hour(), None);
    }

    #[test]
    fn digest_hour_reads_env_then_override() {
        let env = MapEnv::new([("DIGEST_HOUR", "7")]);
        assert_eq!(config(&Overrides::new(), &env).digest_hour(), Some(7));

        let overrides = saved(json!({"digest_hour": 9}));
        assert_eq!(config(&overrides, &env).digest_hour(), Some(9));
    }

    #[test]
    fn a_saved_minus_one_turns_the_digest_off() {
        let overrides = saved(json!({"digest_hour": -1}));
        let env = MapEnv::new([("DIGEST_HOUR", "7")]);
        assert_eq!(
            config(&overrides, &env).digest_hour(),
            None,
            "an explicit off must beat the env"
        );
    }

    #[test]
    fn a_malformed_digest_hour_env_is_off() {
        for raw in ["", "morning", "24", "-1", "9.5"] {
            let env = MapEnv::new([("DIGEST_HOUR", raw)]);
            assert_eq!(
                config(&Overrides::new(), &env).digest_hour(),
                None,
                "{raw:?} should disable the digest"
            );
        }
    }

    #[test]
    fn digest_hour_env_accepts_the_whole_valid_range() {
        for hour in 0..=23u32 {
            let env = MapEnv::new([("DIGEST_HOUR", hour.to_string())]);
            assert_eq!(config(&Overrides::new(), &env).digest_hour(), Some(hour));
        }
    }

    // --- fee threshold ------------------------------------------------------

    #[test]
    fn the_fee_ping_is_off_by_default() {
        assert_eq!(
            config(&Overrides::new(), &empty_env()).fee_threshold(),
            None
        );
    }

    #[test]
    fn fee_threshold_reads_env_then_override() {
        let env = MapEnv::new([("ALERT_FEE_USD", "25")]);
        assert_eq!(config(&Overrides::new(), &env).fee_threshold(), Some(25.0));

        let overrides = saved(json!({"fee_usd": 50}));
        assert_eq!(config(&overrides, &env).fee_threshold(), Some(50.0));
    }

    #[test]
    fn a_malformed_fee_threshold_is_off() {
        for raw in ["lots", "$25", ""] {
            let env = MapEnv::new([("ALERT_FEE_USD", raw)]);
            assert_eq!(config(&Overrides::new(), &env).fee_threshold(), None);
        }
    }

    #[test]
    fn a_negative_fee_threshold_is_off() {
        let env = MapEnv::new([("ALERT_FEE_USD", "-5")]);
        assert_eq!(config(&Overrides::new(), &env).fee_threshold(), None);
    }

    // --- health factor ------------------------------------------------------

    #[test]
    fn the_health_factor_alarm_is_on_by_default() {
        // Unlike every other alert, this one defaults to ON — a liquidation is unrecoverable.
        assert_eq!(
            config(&Overrides::new(), &empty_env()).hf_threshold(),
            Some(1.5)
        );
    }

    #[test]
    fn hf_threshold_reads_env_then_override() {
        let env = MapEnv::new([("ALERT_HF", "2.0")]);
        assert_eq!(config(&Overrides::new(), &env).hf_threshold(), Some(2.0));

        let overrides = saved(json!({"hf_alert": 1.2}));
        assert_eq!(config(&overrides, &env).hf_threshold(), Some(1.2));
    }

    #[test]
    fn a_malformed_health_factor_env_fails_open_to_the_default() {
        // The one accessor that must not fail closed: a typo cannot silence the alarm.
        for raw in ["safe", "1.5x", "none"] {
            let env = MapEnv::new([("ALERT_HF", raw)]);
            assert_eq!(
                config(&Overrides::new(), &env).hf_threshold(),
                Some(1.5),
                "{raw:?} must leave the alarm armed"
            );
        }
    }

    #[test]
    fn an_explicit_zero_health_factor_is_off() {
        // Deliberate, unlike a typo: 0 turns the alarm off.
        let env = MapEnv::new([("ALERT_HF", "0")]);
        assert_eq!(config(&Overrides::new(), &env).hf_threshold(), None);

        let empty = MapEnv::new([("ALERT_HF", "")]);
        assert_eq!(
            config(&Overrides::new(), &empty).hf_threshold(),
            Some(1.5),
            "empty is unset, not off"
        );
    }

    // --- report currency ----------------------------------------------------

    #[test]
    fn the_report_currency_defaults_to_baht() {
        assert_eq!(config(&Overrides::new(), &empty_env()).report_ccy(), "thb");
    }

    #[test]
    fn report_currency_reads_env_then_override() {
        let env = MapEnv::new([("ALERT_REPORT_CCY", "usd")]);
        assert_eq!(config(&Overrides::new(), &env).report_ccy(), "usd");

        let overrides = saved(json!({"report_ccy": "thb"}));
        assert_eq!(config(&overrides, &env).report_ccy(), "thb");
    }

    #[test]
    fn an_unknown_report_currency_falls_back_to_the_default() {
        for raw in ["eur", "JPY", "", "  "] {
            let env = MapEnv::new([("ALERT_REPORT_CCY", raw)]);
            assert_eq!(
                config(&Overrides::new(), &env).report_ccy(),
                "thb",
                "{raw:?} is not renderable"
            );
        }
    }

    #[test]
    fn every_currency_has_a_symbol() {
        assert_eq!(currency_symbol("usd"), Some("$"));
        assert_eq!(currency_symbol("thb"), Some("฿"));
        assert_eq!(currency_symbol("eur"), None);
    }
}
