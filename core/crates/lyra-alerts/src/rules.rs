//! Alert rules — the decision layer of `notify.py` (`check_once` ~793-866, `_maybe_digest` ~749,
//! and the classification helpers ~311-360).
//!
//! Every function here is **pure**: it takes the current readings plus the previous state and
//! returns what to alert on and what the new state should be. No clock, no network, no database.
//! That is what makes the awkward parts — latches, hysteresis, once-a-day timing — testable without
//! sleeping or stubbing a socket. Delivery (Telegram) and persistence live elsewhere.
//!
//! The rules are all variations on one idea: **alert on the edge, not on the level.** A position
//! that is out of range does not ping every 15 minutes; it pings when it *goes* out. Which means
//! every rule needs memory, and memory that survives a restart — otherwise a container redeploy
//! replays every alert the user already acknowledged. See [`crate::state`].
//!
//! Two hysteresis bands stop a value hovering on a threshold from flapping:
//!
//! * fees re-arm only after dropping below **half** the threshold ([`FEE_RESET_RATIO`]) — i.e.
//!   after an actual claim, not after a penny of accrual noise;
//! * a health-factor warning clears only **10% above** the floor ([`HF_CLEAR_RATIO`]), so a
//!   position wobbling on the line is reported once, not hourly.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Fees must fall below `threshold * this` before the "fees ready" ping re-arms.
pub const FEE_RESET_RATIO: f64 = 0.5;
/// Health factor must recover above `threshold * this` before the warning re-arms.
pub const HF_CLEAR_RATIO: f64 = 1.1;

// ===========================================================================
// Inputs
// ===========================================================================

/// Lending health for one position, as the chain layer reports it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Health {
    /// Health factor. `None` when the protocol did not report one — no reading, no alarm.
    pub hf: Option<f64>,
    pub debt_usd: Option<f64>,
    pub collateral_usd: Option<f64>,
}

/// One DeFi position as the rules see it — the fields of `portfolio.py`'s position dict that
/// actually take part in a decision.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PositionInput {
    pub chain: String,
    pub protocol: Option<String>,
    pub id: Option<String>,
    pub name: Option<String>,
    /// `None` means the position has **no range concept** at all (a lending position, an exchange
    /// bot) and is skipped by the range and fee rules — the Python's `if "in_range" not in d`.
    ///
    /// `portfolio.py` omits the key entirely rather than emitting null (`_position` only sets it
    /// `if in_range is not None`), so "absent" and "null" cannot be distinguished here and never
    /// need to be.
    pub in_range: Option<bool>,
    /// Unclaimed fees/rewards in USD (`rewards_usd`).
    pub rewards_usd: Option<f64>,
    pub health: Option<Health>,
}

/// The two thresholds the rules consult, already resolved from config.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Thresholds {
    /// Unclaimed-fee ping, USD. `None` = off.
    pub fee_usd: Option<f64>,
    /// Health-factor floor. `None` = off.
    pub hf: Option<f64>,
}

// ===========================================================================
// State
// ===========================================================================

/// What the last sweep saw for one key. Serialised exactly like the Python's state entries
/// (`{"range": true, "fee_alerted": false}` / `{"hf_alerted": true}`) so a hand-inspected row is
/// recognisable, and so the Python's own state could be imported wholesale.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PositionState {
    /// Last known in-range flag. `None` = never seen, which is what baselines a new position
    /// **silently** — discovering a position that is already out of range is not an event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<bool>,
    /// Whether the "fees ready" ping has already fired for this accrual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee_alerted: Option<bool>,
    /// Whether the health-factor warning is currently latched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hf_alerted: Option<bool>,
}

/// Key -> state for every position the last sweep saw.
pub type PositionStates = HashMap<String, PositionState>;

// ===========================================================================
// Outputs
// ===========================================================================

/// What happened, with the numbers the message needs. Rendering is the delivery layer's job.
#[derive(Debug, Clone, PartialEq)]
pub enum AlertKind {
    /// The position stopped earning — price left the band.
    OutOfRange,
    /// The position is earning again.
    BackInRange,
    FeesReady {
        fees_usd: f64,
        threshold: f64,
    },
    /// A lending position is approaching liquidation.
    HealthFactorLow {
        hf: f64,
        threshold: f64,
        debt_usd: f64,
        collateral_usd: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    /// The state key this alert came from — the same key the latch is stored under.
    pub key: String,
    pub chain: String,
    /// `_label`: `"<name or protocol or 'position'> · <chain>"`.
    pub label: String,
    pub kind: AlertKind,
}

/// The result of one sweep: what to send, and what to remember.
///
/// `state` is rebuilt from scratch every sweep, so a position that disappears (wallet removed, LP
/// closed) drops out of state entirely and would be baselined silently if it ever returns — the
/// Python's behaviour, and the reason [`crate::state::AlertStore::save_positions`] replaces rather
/// than merges.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Evaluation {
    pub alerts: Vec<Alert>,
    pub state: PositionStates,
}

// ===========================================================================
// Keys and labels
// ===========================================================================

/// Python renders `None` into an f-string as the literal `"None"`; the key format depends on that,
/// and a key that changed shape would re-baseline every position exactly once — silently losing a
/// sweep of alerts. So it is reproduced rather than improved.
fn or_none(value: Option<&str>) -> &str {
    value.unwrap_or("None")
}

/// `f"{chain}:{protocol}:{id or name}"`.
///
/// `id or name` is Python truthiness: an empty id falls back to the name.
pub fn position_key(
    chain: &str,
    protocol: Option<&str>,
    id: Option<&str>,
    name: Option<&str>,
) -> String {
    let identity = id
        .filter(|value| !value.is_empty())
        .or(name.filter(|value| !value.is_empty()));
    format!("{chain}:{}:{}", or_none(protocol), or_none(identity))
}

/// `f"{chain}:{protocol}:hf"` — the lending latch is per protocol, not per position, so two
/// positions in the same market share one warning.
pub fn hf_key(chain: &str, protocol: Option<&str>) -> String {
    format!("{chain}:{}:hf", or_none(protocol))
}

/// `_label`.
pub fn label(name: Option<&str>, protocol: Option<&str>, chain: &str) -> String {
    let identity = name
        .filter(|value| !value.is_empty())
        .or(protocol.filter(|value| !value.is_empty()))
        .unwrap_or("position");
    format!("{identity} · {chain}")
}

impl PositionInput {
    pub fn key(&self) -> String {
        position_key(
            &self.chain,
            self.protocol.as_deref(),
            self.id.as_deref(),
            self.name.as_deref(),
        )
    }

    pub fn hf_key(&self) -> String {
        hf_key(&self.chain, self.protocol.as_deref())
    }

    pub fn label(&self) -> String {
        label(self.name.as_deref(), self.protocol.as_deref(), &self.chain)
    }
}

// ===========================================================================
// The sweep
// ===========================================================================

/// One sweep: diff the current positions against the previous state and decide what to send.
///
/// Pure — same inputs, same outputs, no clock. The caller loads `prev` from storage, sends
/// `alerts`, and persists `state`.
pub fn evaluate(
    positions: &[PositionInput],
    prev: &PositionStates,
    thresholds: &Thresholds,
) -> Evaluation {
    let mut alerts = Vec::new();
    let mut state = PositionStates::new();

    for position in positions {
        // --- lending health: latched, with a 10% clear band ---------------
        if let (Some(health), Some(threshold)) = (position.health.as_ref(), thresholds.hf)
            && let Some(hf) = health.hf
        {
            let key = position.hf_key();
            let mut latched = prev
                .get(&key)
                .and_then(|state| state.hf_alerted)
                .unwrap_or(false);

            if hf < threshold && !latched {
                alerts.push(Alert {
                    key: key.clone(),
                    chain: position.chain.clone(),
                    label: position.label(),
                    kind: AlertKind::HealthFactorLow {
                        hf,
                        threshold,
                        debt_usd: health.debt_usd.unwrap_or(0.0),
                        collateral_usd: health.collateral_usd.unwrap_or(0.0),
                    },
                });
                latched = true;
            } else if hf >= threshold * HF_CLEAR_RATIO {
                latched = false;
            }
            // Between the floor and the clear band the latch is left exactly as it was: that gap
            // is what stops a position hovering on the line from re-alerting every sweep.

            state.insert(
                key,
                PositionState {
                    hf_alerted: Some(latched),
                    ..Default::default()
                },
            );
        }

        // Positions with no range concept take no further part — the Python `continue`s here.
        let Some(in_range) = position.in_range else {
            continue;
        };

        let key = position.key();
        let previous = prev.get(&key);
        let mut fee_alerted = previous
            .and_then(|state| state.fee_alerted)
            .unwrap_or(false);

        // --- range transition: only against a *known* prior state ---------
        if let Some(was_in_range) = previous.and_then(|state| state.range)
            && was_in_range != in_range
        {
            alerts.push(Alert {
                key: key.clone(),
                chain: position.chain.clone(),
                label: position.label(),
                kind: if in_range {
                    AlertKind::BackInRange
                } else {
                    AlertKind::OutOfRange
                },
            });
        }

        // --- fees ready: latched, re-arms below half the threshold --------
        if let Some(threshold) = thresholds.fee_usd {
            let fees = position.rewards_usd.unwrap_or(0.0);
            if fees >= threshold && !fee_alerted {
                alerts.push(Alert {
                    key: key.clone(),
                    chain: position.chain.clone(),
                    label: position.label(),
                    kind: AlertKind::FeesReady {
                        fees_usd: fees,
                        threshold,
                    },
                });
                fee_alerted = true;
            } else if fees < threshold * FEE_RESET_RATIO {
                fee_alerted = false;
            }
        }
        // With the fee ping off, the latch carries over untouched, so turning the threshold back
        // on does not replay a ping the user already saw.

        state.insert(
            key,
            PositionState {
                range: Some(in_range),
                fee_alerted: Some(fee_alerted),
                hf_alerted: None,
            },
        );
    }

    Evaluation { alerts, state }
}

// ===========================================================================
// Digest timing
// ===========================================================================

/// The clock, decomposed — injected rather than read, so digest timing is testable without
/// waiting for 9am or setting a process-wide `TZ`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestClock {
    /// Local hour of day, 0-23 (`time.localtime().tm_hour`).
    pub hour: u32,
    /// Local date as `%Y-%m-%d` (`time.strftime("%Y-%m-%d")`).
    pub day: String,
}

impl DigestClock {
    pub fn new(hour: u32, day: impl Into<String>) -> Self {
        Self {
            hour,
            day: day.into(),
        }
    }

    /// Decompose a local timestamp. The caller owns the timezone — this crate never picks one.
    pub fn from_local(now: chrono::NaiveDateTime) -> Self {
        use chrono::{Datelike, Timelike};
        Self {
            hour: now.hour(),
            day: format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day()),
        }
    }
}

/// Port of `_maybe_digest`'s condition: send once, on the sweep that first finds the clock at the
/// configured hour on a day the digest has not already gone out.
///
/// `deliverable` folds in `digest_enabled()`'s other half — credentials present and something to
/// report. The day is recorded only after a *successful* send, so a delivery failure retries on the
/// next sweep within the same hour.
pub fn should_send_digest(
    clock: &DigestClock,
    digest_hour: Option<u32>,
    last_sent_day: Option<&str>,
    deliverable: bool,
) -> bool {
    if !deliverable {
        return false;
    }
    let Some(hour) = digest_hour else {
        return false;
    };
    clock.hour == hour && last_sent_day != Some(clock.day.as_str())
}

// ===========================================================================
// Classification — the Capital Ladder
// ===========================================================================

/// Hard money: BTC and its wrapped forms, ETH and its liquid-staking forms, and gold — including
/// the `GOLD` symbol the metals alias onto. Mirrors `web/src/lib/compute.ts`'s `HARD`; the digest's
/// tier split has to match the Overview's.
pub const HARD: [&str; 17] = [
    "BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "UBTC", "ETH", "WETH", "STETH", "WSTETH", "RETH",
    "WEETH", "XAUT", "PAXG", "KAU", "XAU", "GOLD",
];

/// Categories that are speculation rather than capital at work — CEX bots and derivatives.
pub const TRADING_CATS: [&str; 4] = ["Perps", "Futures", "Rebalance", "Spot Grid"];
/// Categories that are productive DeFi.
pub const BUSINESS_CATS: [&str; 2] = ["Liquidity Pool", "Yield"];

/// BTC and every wrapped/bridged form of it — `_BTC_SYMS`, for the "sats" readout.
pub const BTC_SYMS: [&str; 7] = ["BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "BTC.B", "UBTC"];

/// The three rungs of the Capital Ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Hard money held directly.
    Store,
    /// Working capital — productive DeFi, cash, stables, alts.
    Business,
    /// Speculation — derivatives and exchange bots.
    Trading,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Store => "store",
            Tier::Business => "business",
            Tier::Trading => "trading",
        }
    }
}

/// Port of `_tier`. Category decides first; only an uncategorised holding is judged by its symbol.
///
/// The default is **business**, not store: cash, stables and alts are all working capital. That
/// asymmetry is the point of the ladder — you have to *hold hard money directly* to be storing.
pub fn tier(symbol: Option<&str>, category: Option<&str>) -> Tier {
    if let Some(category) = category {
        if TRADING_CATS.contains(&category) {
            return Tier::Trading;
        }
        if BUSINESS_CATS.contains(&category) {
            return Tier::Business;
        }
    }
    let symbol = symbol.unwrap_or("").to_uppercase();
    if HARD.contains(&symbol.as_str()) {
        return Tier::Store;
    }
    Tier::Business
}

/// Port of `_is_btc` — is this symbol BTC in any wrapper?
pub fn is_btc(symbol: Option<&str>) -> bool {
    BTC_SYMS.contains(&symbol.unwrap_or("").to_uppercase().as_str())
}

/// Wrapped/bridged forms collapsed onto the coin they track — `_SYM_ALIAS`, for the exposure lens.
/// Without this, WHYPE and HYPE read as two unrelated bets.
pub fn alias(symbol: &str) -> Option<&'static str> {
    Some(match symbol {
        "WBTC" | "CBBTC" | "TBTC" | "LBTC" | "BTC.B" => "BTC",
        "WETH" | "STETH" | "WSTETH" | "RETH" | "WEETH" | "ETH.B" => "ETH",
        "WSOL" | "MSOL" | "JITOSOL" => "SOL",
        "WPOL" | "WMATIC" | "MATIC" => "POL",
        "WBNB" => "BNB",
        "WAVAX" => "AVAX",
        "WHYPE" => "HYPE",
        "USDC.E" => "USDC",
        "XAUT" | "PAXG" | "KAU" | "XAU" => "GOLD",
        _ => return None,
    })
}

/// Port of `_norm_sym`: upper-case, then alias.
pub fn norm_sym(symbol: Option<&str>) -> String {
    let upper = symbol.unwrap_or("").to_uppercase();
    alias(&upper).map(str::to_string).unwrap_or(upper)
}

/// Port of `_expo_add`: accumulate USD exposure under the normalised symbol.
///
/// Skips empty symbols and non-positive amounts, so a zeroed dust row cannot create an exposure
/// bucket that renders as a 0% slice.
pub fn expo_add(exposure: &mut HashMap<String, f64>, symbol: Option<&str>, usd: f64) {
    let symbol = norm_sym(symbol);
    if symbol.is_empty() || usd <= 0.0 {
        return;
    }
    *exposure.entry(symbol).or_insert(0.0) += usd;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn lp(name: &str, in_range: bool, fees: f64) -> PositionInput {
        PositionInput {
            chain: "base".into(),
            protocol: Some("Aerodrome".into()),
            id: Some(format!("id-{name}")),
            name: Some(name.into()),
            in_range: Some(in_range),
            rewards_usd: Some(fees),
            health: None,
        }
    }

    fn lending(hf: f64) -> PositionInput {
        PositionInput {
            chain: "base".into(),
            protocol: Some("Aave".into()),
            id: Some("aave-1".into()),
            name: Some("USDC market".into()),
            in_range: None,
            rewards_usd: None,
            health: Some(Health {
                hf: Some(hf),
                debt_usd: Some(10_000.0),
                collateral_usd: Some(20_000.0),
            }),
        }
    }

    fn thresholds(fee: Option<f64>, hf: Option<f64>) -> Thresholds {
        Thresholds { fee_usd: fee, hf }
    }

    /// One sweep, carrying state forward the way the poller does.
    fn sweep(
        positions: &[PositionInput],
        prev: &PositionStates,
        thresholds: &Thresholds,
    ) -> Evaluation {
        evaluate(positions, prev, thresholds)
    }

    // --- keys and labels ----------------------------------------------------

    #[test]
    fn the_key_shape_matches_python_including_its_none_rendering() {
        // A changed key shape silently re-baselines every position, losing one sweep of alerts.
        assert_eq!(
            position_key("base", Some("Aerodrome"), Some("42"), Some("ETH/USDC")),
            "base:Aerodrome:42"
        );
        assert_eq!(
            position_key("base", Some("Aerodrome"), None, Some("ETH/USDC")),
            "base:Aerodrome:ETH/USDC",
            "id falls back to name"
        );
        assert_eq!(
            position_key("base", None, None, None),
            "base:None:None",
            "Python formats None into the string"
        );
        assert_eq!(hf_key("base", Some("Aave")), "base:Aave:hf");
    }

    #[test]
    fn an_empty_id_falls_back_to_the_name_like_python_truthiness() {
        assert_eq!(
            position_key("base", Some("Aero"), Some(""), Some("ETH/USDC")),
            "base:Aero:ETH/USDC"
        );
    }

    #[test]
    fn the_label_prefers_name_then_protocol() {
        assert_eq!(
            label(Some("ETH/USDC"), Some("Aero"), "base"),
            "ETH/USDC · base"
        );
        assert_eq!(label(None, Some("Aero"), "base"), "Aero · base");
        assert_eq!(label(None, None, "base"), "position · base");
    }

    // --- range transitions --------------------------------------------------

    #[test]
    fn a_newly_seen_position_is_baselined_silently() {
        // Discovering a position that is already out of range is not an event.
        let result = sweep(
            &[lp("ETH/USDC", false, 0.0)],
            &PositionStates::new(),
            &thresholds(None, None),
        );
        assert!(result.alerts.is_empty(), "{:?}", result.alerts);
        assert_eq!(
            result.state["base:Aerodrome:id-ETH/USDC"].range,
            Some(false)
        );
    }

    #[test]
    fn leaving_and_re_entering_range_each_alert_once() {
        let thresholds = thresholds(None, None);
        let first = sweep(&[lp("P", true, 0.0)], &PositionStates::new(), &thresholds);
        assert!(first.alerts.is_empty());

        let out = sweep(&[lp("P", false, 0.0)], &first.state, &thresholds);
        assert_eq!(out.alerts.len(), 1);
        assert_eq!(out.alerts[0].kind, AlertKind::OutOfRange);

        // Still out: no repeat.
        let still_out = sweep(&[lp("P", false, 0.0)], &out.state, &thresholds);
        assert!(
            still_out.alerts.is_empty(),
            "an ongoing state is not an event"
        );

        let back = sweep(&[lp("P", true, 0.0)], &still_out.state, &thresholds);
        assert_eq!(back.alerts.len(), 1);
        assert_eq!(back.alerts[0].kind, AlertKind::BackInRange);
    }

    #[test]
    fn a_position_that_disappears_is_dropped_from_state() {
        let thresholds = thresholds(None, None);
        let first = sweep(&[lp("P", true, 0.0)], &PositionStates::new(), &thresholds);
        let gone = sweep(&[], &first.state, &thresholds);
        assert!(gone.state.is_empty(), "state is rebuilt, not merged");
    }

    // --- fee latch ----------------------------------------------------------

    #[test]
    fn the_fee_ping_fires_once_per_accrual() {
        let thresholds = thresholds(Some(25.0), None);
        let first = sweep(&[lp("P", true, 30.0)], &PositionStates::new(), &thresholds);
        assert_eq!(first.alerts.len(), 1);
        assert!(matches!(first.alerts[0].kind, AlertKind::FeesReady { .. }));

        // Fees keep accruing — no second ping.
        let again = sweep(&[lp("P", true, 40.0)], &first.state, &thresholds);
        assert!(again.alerts.is_empty(), "{:?}", again.alerts);
    }

    #[test]
    fn the_fee_latch_re_arms_only_below_half_the_threshold() {
        let thresholds = thresholds(Some(25.0), None);
        let fired = sweep(&[lp("P", true, 30.0)], &PositionStates::new(), &thresholds);

        // A partial claim to 20 is above half: still latched, no new ping when it climbs again.
        let partial = sweep(&[lp("P", true, 20.0)], &fired.state, &thresholds);
        assert!(partial.alerts.is_empty());
        assert_eq!(partial.state["base:Aerodrome:id-P"].fee_alerted, Some(true));

        let regrown = sweep(&[lp("P", true, 30.0)], &partial.state, &thresholds);
        assert!(
            regrown.alerts.is_empty(),
            "still the same un-claimed accrual"
        );

        // A real claim drops fees below half — the latch re-arms.
        let claimed = sweep(&[lp("P", true, 1.0)], &regrown.state, &thresholds);
        assert_eq!(
            claimed.state["base:Aerodrome:id-P"].fee_alerted,
            Some(false)
        );
        let next_accrual = sweep(&[lp("P", true, 26.0)], &claimed.state, &thresholds);
        assert_eq!(next_accrual.alerts.len(), 1, "a new accrual pings again");
    }

    #[test]
    fn the_fee_threshold_boundary_is_inclusive() {
        let thresholds = thresholds(Some(25.0), None);
        let exact = sweep(&[lp("P", true, 25.0)], &PositionStates::new(), &thresholds);
        assert_eq!(exact.alerts.len(), 1, "fee >= threshold fires");

        let under = sweep(&[lp("P", true, 24.99)], &PositionStates::new(), &thresholds);
        assert!(under.alerts.is_empty());
    }

    #[test]
    fn with_the_fee_ping_off_the_latch_is_preserved_not_reset() {
        // Turning the threshold off then on must not replay a ping the user already saw.
        let on = thresholds(Some(25.0), None);
        let fired = sweep(&[lp("P", true, 30.0)], &PositionStates::new(), &on);

        let off = sweep(
            &[lp("P", true, 30.0)],
            &fired.state,
            &thresholds(None, None),
        );
        assert!(off.alerts.is_empty());
        assert_eq!(off.state["base:Aerodrome:id-P"].fee_alerted, Some(true));

        let back_on = sweep(&[lp("P", true, 30.0)], &off.state, &on);
        assert!(back_on.alerts.is_empty(), "still latched");
    }

    #[test]
    fn a_position_with_no_fees_reported_is_treated_as_zero() {
        let mut position = lp("P", true, 0.0);
        position.rewards_usd = None;
        let result = sweep(
            &[position],
            &PositionStates::new(),
            &thresholds(Some(25.0), None),
        );
        assert!(result.alerts.is_empty());
    }

    // --- health factor ------------------------------------------------------

    #[test]
    fn a_health_factor_below_the_floor_alerts_once() {
        let thresholds = thresholds(None, Some(1.5));
        let first = sweep(&[lending(1.2)], &PositionStates::new(), &thresholds);
        assert_eq!(first.alerts.len(), 1);
        assert_eq!(
            first.alerts[0].kind,
            AlertKind::HealthFactorLow {
                hf: 1.2,
                threshold: 1.5,
                debt_usd: 10_000.0,
                collateral_usd: 20_000.0,
            }
        );

        // Still unhealthy — no repeat every sweep.
        let again = sweep(&[lending(1.1)], &first.state, &thresholds);
        assert!(again.alerts.is_empty(), "{:?}", again.alerts);
    }

    #[test]
    fn the_health_warning_clears_only_ten_percent_above_the_floor() {
        let thresholds = thresholds(None, Some(1.5));
        let fired = sweep(&[lending(1.2)], &PositionStates::new(), &thresholds);

        // 1.6 is above the floor but inside the 1.65 clear band: still latched.
        let wobble = sweep(&[lending(1.6)], &fired.state, &thresholds);
        assert_eq!(wobble.state["base:Aave:hf"].hf_alerted, Some(true));
        let back_down = sweep(&[lending(1.2)], &wobble.state, &thresholds);
        assert!(back_down.alerts.is_empty(), "the wobble must not re-alert");

        // A real recovery past 1.65 re-arms.
        let recovered = sweep(&[lending(1.7)], &back_down.state, &thresholds);
        assert_eq!(recovered.state["base:Aave:hf"].hf_alerted, Some(false));
        let relapse = sweep(&[lending(1.2)], &recovered.state, &thresholds);
        assert_eq!(relapse.alerts.len(), 1, "a fresh fall alerts again");
    }

    #[test]
    fn a_position_without_a_health_factor_never_alarms() {
        let mut position = lending(1.0);
        position.health = Some(Health {
            hf: None,
            debt_usd: Some(1.0),
            collateral_usd: Some(2.0),
        });
        let result = sweep(
            &[position],
            &PositionStates::new(),
            &thresholds(None, Some(1.5)),
        );
        assert!(result.alerts.is_empty());
        assert!(result.state.is_empty(), "no reading, no state");
    }

    #[test]
    fn the_health_alarm_is_skipped_entirely_when_the_threshold_is_off() {
        let result = sweep(
            &[lending(0.9)],
            &PositionStates::new(),
            &thresholds(None, None),
        );
        assert!(result.alerts.is_empty());
        assert!(result.state.is_empty());
    }

    #[test]
    fn lending_positions_take_no_part_in_the_range_rules() {
        // in_range absent -> the Python `continue`s before the range/fee block.
        let result = sweep(
            &[lending(2.0)],
            &PositionStates::new(),
            &thresholds(Some(1.0), Some(1.5)),
        );
        assert_eq!(result.state.len(), 1);
        assert!(result.state.contains_key("base:Aave:hf"));
        assert!(!result.state.contains_key("base:Aave:aave-1"));
    }

    #[test]
    fn health_and_range_state_live_under_different_keys() {
        // A position with both keeps two independent latches.
        let mut position = lp("P", true, 0.0);
        position.health = Some(Health {
            hf: Some(1.2),
            debt_usd: None,
            collateral_usd: None,
        });
        let result = sweep(
            &[position],
            &PositionStates::new(),
            &thresholds(None, Some(1.5)),
        );
        assert_eq!(result.alerts.len(), 1);
        assert!(result.state.contains_key("base:Aerodrome:hf"));
        assert!(result.state.contains_key("base:Aerodrome:id-P"));
    }

    #[test]
    fn several_positions_are_judged_independently() {
        let thresholds = thresholds(Some(25.0), None);
        let first = sweep(
            &[lp("A", true, 0.0), lp("B", true, 0.0)],
            &PositionStates::new(),
            &thresholds,
        );
        let second = sweep(
            &[lp("A", false, 0.0), lp("B", true, 30.0)],
            &first.state,
            &thresholds,
        );
        assert_eq!(second.alerts.len(), 2);
        assert_eq!(second.alerts[0].kind, AlertKind::OutOfRange);
        assert!(matches!(second.alerts[1].kind, AlertKind::FeesReady { .. }));
    }

    // --- digest timing ------------------------------------------------------

    #[test]
    fn the_digest_fires_at_the_configured_hour_and_only_once_a_day() {
        let clock = DigestClock::new(9, "2026-08-14");
        assert!(should_send_digest(&clock, Some(9), None, true));
        assert!(
            !should_send_digest(&clock, Some(9), Some("2026-08-14"), true),
            "already sent today"
        );
    }

    #[test]
    fn the_digest_stays_quiet_outside_its_hour() {
        for hour in [0, 8, 10, 23] {
            let clock = DigestClock::new(hour, "2026-08-14");
            assert!(
                !should_send_digest(&clock, Some(9), None, true),
                "at {hour}"
            );
        }
    }

    #[test]
    fn the_digest_rolls_over_to_the_next_day() {
        let today = DigestClock::new(9, "2026-08-14");
        assert!(!should_send_digest(
            &today,
            Some(9),
            Some("2026-08-14"),
            true
        ));

        let tomorrow = DigestClock::new(9, "2026-08-15");
        assert!(should_send_digest(
            &tomorrow,
            Some(9),
            Some("2026-08-14"),
            true
        ));
    }

    #[test]
    fn every_sweep_within_the_hour_would_fire_until_the_day_is_recorded() {
        // The day is written only after a successful send, so a failed delivery retries — that is
        // deliberate, and it is why the "already sent" check is on the day, not the hour.
        let clock = DigestClock::new(9, "2026-08-14");
        assert!(should_send_digest(&clock, Some(9), None, true));
        assert!(should_send_digest(&clock, Some(9), None, true));
    }

    #[test]
    fn a_disabled_or_undeliverable_digest_never_fires() {
        let clock = DigestClock::new(9, "2026-08-14");
        assert!(!should_send_digest(&clock, None, None, true), "hour unset");
        assert!(
            !should_send_digest(&clock, Some(9), None, false),
            "no credentials or nothing to report"
        );
    }

    #[test]
    fn midnight_is_a_valid_digest_hour() {
        let clock = DigestClock::new(0, "2026-08-14");
        assert!(should_send_digest(&clock, Some(0), None, true));
    }

    #[test]
    fn the_clock_decomposes_a_local_timestamp() {
        let now = chrono::NaiveDate::from_ymd_opt(2026, 8, 14)
            .unwrap()
            .and_hms_opt(9, 30, 0)
            .unwrap();
        let clock = DigestClock::from_local(now);
        assert_eq!(clock.hour, 9);
        assert_eq!(clock.day, "2026-08-14");
    }

    // --- classification -----------------------------------------------------

    #[test]
    fn category_decides_the_tier_before_the_symbol_does() {
        // BTC in a perp basket is a trade, not a store of value.
        assert_eq!(tier(Some("BTC"), Some("Perps")), Tier::Trading);
        assert_eq!(tier(Some("BTC"), Some("Liquidity Pool")), Tier::Business);
        assert_eq!(tier(Some("BTC"), None), Tier::Store);
    }

    #[test]
    fn unrecognised_holdings_default_to_business() {
        // Cash, stables and alts are all working capital — you must hold hard money to be storing.
        assert_eq!(tier(Some("USDC"), None), Tier::Business);
        assert_eq!(tier(Some("PEPE"), None), Tier::Business);
        assert_eq!(tier(None, None), Tier::Business);
        assert_eq!(tier(Some("BTC"), Some("Unknown Category")), Tier::Store);
    }

    #[test]
    fn tier_symbol_matching_is_case_insensitive() {
        assert_eq!(tier(Some("wbtc"), None), Tier::Store);
        assert_eq!(tier(Some("WeEth"), None), Tier::Store);
    }

    #[test]
    fn gold_counts_as_hard_money() {
        for symbol in ["XAUT", "PAXG", "KAU", "XAU", "GOLD"] {
            assert_eq!(tier(Some(symbol), None), Tier::Store, "{symbol}");
        }
    }

    #[test]
    fn btc_is_recognised_through_every_wrapper() {
        for symbol in ["BTC", "WBTC", "cbBTC", "tBTC", "LBTC", "BTC.B", "uBTC"] {
            assert!(is_btc(Some(symbol)), "{symbol}");
        }
        assert!(!is_btc(Some("ETH")));
        assert!(!is_btc(None));
    }

    #[test]
    fn aliasing_collapses_wrapped_forms_onto_the_coin_they_track() {
        assert_eq!(norm_sym(Some("WHYPE")), "HYPE");
        assert_eq!(norm_sym(Some("jitoSOL")), "SOL");
        assert_eq!(norm_sym(Some("usdc.e")), "USDC");
        assert_eq!(norm_sym(Some("MATIC")), "POL");
        assert_eq!(norm_sym(Some("PAXG")), "GOLD");
        assert_eq!(norm_sym(Some("HYPE")), "HYPE", "unaliased passes through");
        assert_eq!(norm_sym(None), "");
    }

    #[test]
    fn exposure_nets_wrapped_forms_together() {
        let mut exposure = HashMap::new();
        expo_add(&mut exposure, Some("HYPE"), 100.0);
        expo_add(&mut exposure, Some("WHYPE"), 50.0);
        expo_add(&mut exposure, Some("wbtc"), 25.0);
        assert_eq!(exposure["HYPE"], 150.0, "one bet, not two");
        assert_eq!(exposure["BTC"], 25.0);
    }

    #[test]
    fn exposure_ignores_empty_symbols_and_worthless_rows() {
        let mut exposure = HashMap::new();
        expo_add(&mut exposure, None, 100.0);
        expo_add(&mut exposure, Some(""), 100.0);
        expo_add(&mut exposure, Some("ETH"), 0.0);
        expo_add(&mut exposure, Some("ETH"), -5.0);
        assert!(exposure.is_empty(), "{exposure:?}");
    }

    // --- parity corpus ------------------------------------------------------

    /// One recorded call to the Python helpers. `is_btc`/`norm_sym` depend only on the symbol, so
    /// they are recorded once per symbol rather than on every row.
    #[derive(serde::Deserialize)]
    struct TierCase {
        symbol: Option<String>,
        category: Option<String>,
        tier: String,
        is_btc: Option<bool>,
        norm_sym: Option<String>,
    }

    fn corpus() -> Vec<TierCase> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/tier_corpus.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        serde_json::from_str(&raw).expect("corpus is valid JSON")
    }

    #[test]
    fn tier_agrees_with_python_across_the_generated_corpus() {
        // Every (symbol, category) pair run through the real `notify._tier` — including case
        // variants, the empty symbol, and a None symbol. Regenerate with
        // wallet-portfolio/.venv/bin/python on the generator in the commit message.
        let cases = corpus();
        assert!(cases.len() > 500, "corpus too small: {}", cases.len());

        for case in &cases {
            assert_eq!(
                tier(case.symbol.as_deref(), case.category.as_deref()).as_str(),
                case.tier,
                "symbol={:?} category={:?}",
                case.symbol,
                case.category
            );
        }
    }

    #[test]
    fn the_corpus_exercises_all_three_tiers() {
        // A corpus that only ever produced "business" would pass against a stub.
        let cases = corpus();
        for expected in ["store", "business", "trading"] {
            assert!(
                cases.iter().filter(|c| c.tier == expected).count() > 20,
                "corpus barely covers {expected}"
            );
        }
    }

    #[test]
    fn is_btc_and_norm_sym_agree_with_python() {
        let mut checked = 0;
        for case in &corpus() {
            let symbol = case.symbol.as_deref();
            if let Some(expected) = case.is_btc {
                assert_eq!(is_btc(symbol), expected, "is_btc({symbol:?})");
                checked += 1;
            }
            if let Some(expected) = &case.norm_sym {
                assert_eq!(&norm_sym(symbol), expected, "norm_sym({symbol:?})");
            }
        }
        assert!(
            checked > 40,
            "only {checked} symbols carried a recorded answer"
        );
    }
}
