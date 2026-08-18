//! Message rendering and daily-brief assembly — port of the rendering half of `notify.py`
//! (`_report_money`/`_CCY_SYM`, the alert texts in `check_once`, the `sec_*` report sections,
//! `_render`/`build_digest`, and the once-a-day `_digest_day` gate).
//!
//! # Why rendering lives here and not in `rules.rs`
//!
//! [`crate::rules::evaluate`] returns [`AlertKind`] variants carrying raw numbers, never strings.
//! That separation is what makes the rules exhaustively testable — a rule test asserts "this
//! health factor fires once and latches", not "this sentence has the right emoji". Everything
//! that turns a number into words is in this module, and nothing here decides *whether* to
//! alert.
//!
//! # Everything here is pure
//!
//! No HTTP, no database, no clock. The digest takes the figures and the previous snapshot as
//! arguments; the caller does the I/O and hands [`digest_due`] the current hour. That is what
//! lets the whole brief — a message assembled from a dozen conditional sections — be asserted
//! character for character in a unit test.

use crate::config::currency_symbol;
use crate::rules::{Alert, AlertKind};

/// Telegram renders the digest with `parse_mode: Markdown`.
///
/// Characters that open Markdown syntax. An on-chain pair name is untrusted text that lands in a
/// **formatted** message, so an unescaped `*` or `[` does not merely look odd: Telegram rejects
/// the whole request with `can't parse entities`, and the alert is silently never delivered. The
/// set is `tgbot.py`'s `_MD_STRIP`, applied here to the outbound path it was missing from.
const MARKDOWN_META: [char; 8] = ['*', '_', '`', '[', ']', '(', ')', '~'];

/// Neuter Markdown in caller-supplied text — port of `tgbot._safe`, minus its 32-char cap.
///
/// Applied to every on-chain label the digest interpolates. See [`MARKDOWN_META`] for why this
/// is a delivery concern rather than a cosmetic one.
pub fn strip_markdown(text: &str) -> String {
    text.chars()
        .filter(|c| !MARKDOWN_META.contains(c))
        .collect::<String>()
        .trim()
        .to_string()
}

// ===========================================================================
// Number formatting
// ===========================================================================

/// `f"{value:,.{decimals}f}"` — fixed decimals with thousands separators.
fn grouped(value: f64, decimals: usize) -> String {
    let rendered = format!("{value:.decimals$}");
    let (sign, rest) = match rendered.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", rendered.as_str()),
    };
    let (integer, fraction) = match rest.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (rest, None),
    };
    let mut out = String::with_capacity(rendered.len() + integer.len() / 3);
    out.push_str(sign);
    for (i, c) in integer.chars().enumerate() {
        if i > 0 && (integer.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if let Some(fraction) = fraction {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

/// Plain USD, as the alert texts use it: cents under $100, whole dollars above. `notify._usd`.
pub fn usd(value: f64) -> String {
    if value.abs() >= 100.0 {
        format!("${}", grouped(value, 0))
    } else {
        format!("${}", grouped(value, 2))
    }
}

/// The report currency, resolved once with its FX rate.
///
/// Everything is collected in USD; only the display converts. A non-USD currency with no live
/// rate **falls back to USD** rather than rendering a blank or a wrong number — better an honest
/// dollar figure than a baht figure computed from a rate we do not have.
#[derive(Debug, Clone, PartialEq)]
pub struct Money {
    code: String,
    symbol: String,
    multiplier: f64,
}

impl Money {
    /// `usd_to_ccy` is the rate for `code`; pass `None` when it is unavailable.
    pub fn new(code: &str, usd_to_ccy: Option<f64>) -> Self {
        let code = code.to_lowercase();
        // A missing or nonsensical rate demotes the whole report to USD.
        let (code, multiplier) = match (code.as_str(), usd_to_ccy) {
            ("usd", _) => ("usd".to_string(), 1.0),
            (_, Some(rate)) if rate.is_finite() && rate > 0.0 => (code, rate),
            _ => ("usd".to_string(), 1.0),
        };
        let symbol = currency_symbol(&code).unwrap_or("$").to_string();
        Self {
            code,
            symbol,
            multiplier,
        }
    }

    /// USD, for when no FX is involved.
    pub fn usd() -> Self {
        Self::new("usd", None)
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    /// Format a USD amount in the report currency.
    ///
    /// THB shows whole baht once the figure is meaningful and one decimal below ฿10, so dust
    /// fees do not collapse to `฿0`. USD keeps cents under $100.
    pub fn fmt(&self, usd_amount: f64) -> String {
        let value = usd_amount * self.multiplier;
        let decimals = if self.code == "thb" {
            if value.abs() >= 10.0 { 0 } else { 1 }
        } else if value.abs() >= 100.0 {
            0
        } else {
            2
        };
        format!("{}{}", self.symbol, grouped(value, decimals))
    }

    /// Signed, with a typographic minus so a negative reads at a glance.
    pub fn signed(&self, usd_amount: f64) -> String {
        let sign = if usd_amount >= 0.0 { "+" } else { "−" };
        format!("{sign}{}", self.fmt(usd_amount.abs()))
    }
}

/// Compact sats: `1.23M`, `45k`, `800`. `notify._ksat`.
fn ksat(value: f64) -> String {
    if value >= 1e6 {
        format!("{:.2}M", value / 1e6)
    } else if value >= 1e3 {
        format!("{:.0}k", value / 1e3)
    } else {
        format!("{value:.0}")
    }
}

/// ①..⑳ for 1-20, else `N)`. Numbers the positions so near-identical pairs stay countable.
fn circled(n: usize) -> String {
    if (1..=20).contains(&n) {
        char::from_u32(0x245F + n as u32)
            .map(String::from)
            .unwrap_or_else(|| format!("{n})"))
    } else {
        format!("{n})")
    }
}

// ===========================================================================
// Alert messages
// ===========================================================================

/// The price band behind an out-of-range alert.
///
/// Passed alongside the alert rather than carried inside [`AlertKind`], which holds no band —
/// so a caller without the band still gets a correct (if shorter) message.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Edge {
    pub cur: Option<f64>,
    pub lower: Option<f64>,
    pub upper: Option<f64>,
}

impl Edge {
    /// How far out of range the price has moved, as a sentence with a trailing space — or empty
    /// when the band cannot support the claim. `notify._edge`.
    ///
    /// Mirrors Python truthiness: a zero price or a zero bound is treated as absent, because a
    /// percentage against zero is not a fact.
    pub fn sentence(&self) -> String {
        let cur = self.cur.filter(|v| *v != 0.0);
        let lower = self.lower.filter(|v| *v != 0.0);
        let upper = self.upper.filter(|v| *v != 0.0);
        if let (Some(cur), Some(lower)) = (cur, lower)
            && cur < lower
        {
            return format!(
                "Price fell {:.1}% below your min. ",
                ((cur - lower) / lower * 100.0).abs()
            );
        }
        if let (Some(cur), Some(upper)) = (cur, upper)
            && cur > upper
        {
            return format!(
                "Price rose {:.1}% above your max. ",
                ((cur - upper) / upper * 100.0).abs()
            );
        }
        String::new()
    }
}

/// Render one alert as the Telegram message `notify.check_once` would have sent.
///
/// `edge` only affects [`AlertKind::OutOfRange`] and may be `None`.
pub fn render_alert(alert: &Alert, edge: Option<&Edge>) -> String {
    let label = strip_markdown(&alert.label);
    match &alert.kind {
        AlertKind::BackInRange => {
            format!("✅ *Back in range*\n{label}\nEarning fees again.")
        }
        AlertKind::OutOfRange => {
            let edge = edge.map(Edge::sentence).unwrap_or_default();
            format!("⚠️ *Out of range*\n{label}\n{edge}Idle until price returns or you rebalance.")
        }
        AlertKind::FeesReady {
            fees_usd,
            threshold,
        } => format!(
            "💰 *Fees ready*\n{label}\nUnclaimed fees ≈ ${} (≥ ${}).",
            grouped(*fees_usd, 2),
            grouped(*threshold, 0)
        ),
        AlertKind::HealthFactorLow {
            hf,
            threshold,
            debt_usd,
            collateral_usd,
        } => format!(
            "🛡️ *Health factor low*\n{label}\nHF {hf:.2} (< {threshold:.2}) · ${} borrowed \
             against ${}. Add collateral or repay.",
            grouped(*debt_usd, 0),
            grouped(*collateral_usd, 0)
        ),
    }
}

// ===========================================================================
// The daily brief
// ===========================================================================

/// Capital-Ladder split, in USD. The digest's three-tier view (`notify._tier`), which is coarser
/// than the four-rung ladder in `lyra-analytics` — kept as-is so the brief matches the web app's
/// tier card.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tiers {
    pub store: f64,
    pub business: f64,
    pub trading: f64,
}

/// One position line in the DeFi ledger.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PoolLine {
    /// Untrusted on-chain label — stripped of Markdown before it is rendered.
    pub name: String,
    pub protocol: String,
    pub usd: f64,
    pub fees: f64,
    /// `None` for a position with no range (an exchange bot), which keeps it out of the ledger.
    pub in_range: Option<bool>,
}

/// One 24h mover: how much of the change this holding contributed, in USD.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mover {
    pub label: String,
    pub contrib_usd: f64,
}

/// The figures the brief renders. The caller aggregates these from the book (`notify._collect`);
/// this module only formats them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DigestInput {
    pub total: f64,
    /// Signed 24h contribution in USD, with the pre-move value backed out.
    pub contrib: f64,
    pub claimable: f64,
    /// BTC reserves in USD (spot + wrapped + LP legs).
    pub btc_usd: f64,
    pub btc_price: Option<f64>,
    pub btc_sats: Option<f64>,
    pub debt: f64,
    pub collateral: f64,
    /// Tightest health factor across borrow positions.
    pub hf_min: Option<f64>,
    pub tiers: Tiers,
    pub movers: Vec<Mover>,
    pub pools: Vec<PoolLine>,
}

/// The few figures the previous brief left behind, for the "since last" deltas.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DigestSnapshot {
    pub total: Option<f64>,
    pub claimable: Option<f64>,
    pub btc_sats: Option<f64>,
}

impl DigestSnapshot {
    /// Reduce a rendered brief's figures to what the next one diffs against.
    pub fn of(input: &DigestInput) -> Self {
        Self {
            total: Some(input.total),
            claimable: Some(input.claimable),
            btc_sats: input.btc_sats,
        }
    }
}

const TIER_SQUARES: [(&str, &str, &str); 3] = [
    ("store", "🟨", "Store"),
    ("business", "🟩", "Business"),
    ("trading", "🟪", "Trading"),
];

/// Cells in the allocation bar.
const BAR_CELLS: usize = 12;

/// A proportional square bar: `BAR_CELLS` squares split by value, largest-remainder rounding so
/// it always sums to exactly `BAR_CELLS` and every nonzero tier keeps at least one square.
fn tier_bar(parts: &[(usize, f64)], total: f64) -> String {
    let raw: Vec<(usize, f64)> = parts
        .iter()
        .map(|(i, value)| (*i, value / total * BAR_CELLS as f64))
        .collect();
    let mut base: Vec<(usize, usize)> = raw
        .iter()
        .map(|(i, exact)| (*i, (exact.trunc() as usize).max(1)))
        .collect();
    let mut used: usize = base.iter().map(|(_, n)| n).sum();

    // Who is most owed a cell. Python sorts (remainder, key) descending, so ties break on the
    // tier *name* — reproduced rather than improved, so the bar is byte-identical.
    let mut remainders: Vec<(f64, &str, usize)> = raw
        .iter()
        .map(|(i, exact)| (exact - exact.trunc(), TIER_SQUARES[*i].0, *i))
        .collect();
    remainders.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| b.1.cmp(a.1)));

    let mut i = 0;
    while used < BAR_CELLS && i < remainders.len() {
        let slot = remainders[i].2;
        if let Some(entry) = base.iter_mut().find(|(idx, _)| *idx == slot) {
            entry.1 += 1;
            used += 1;
        }
        i += 1;
    }
    let mut j = remainders.len() as isize - 1;
    while used > BAR_CELLS && j >= 0 {
        let slot = remainders[j as usize].2;
        if let Some(entry) = base.iter_mut().find(|(idx, _)| *idx == slot)
            && entry.1 > 1
        {
            entry.1 -= 1;
            used -= 1;
        }
        j -= 1;
    }
    base.iter()
        .map(|(i, n)| TIER_SQUARES[*i].1.repeat(*n))
        .collect()
}

fn section_networth(input: &DigestInput, prev: &DigestSnapshot, money: &Money) -> Vec<String> {
    let base = input.total - input.contrib;
    let pct = if base != 0.0 {
        input.contrib / base * 100.0
    } else {
        0.0
    };
    let dot = if input.contrib >= 0.0 { "🟢" } else { "🔴" };
    let mut line = format!("*24h:* {dot} {} ({pct:+.1}%)", money.signed(input.contrib));
    // Python's truthiness: a previous total of 0 counts as "no previous brief".
    if let Some(previous) = prev.total.filter(|t| *t != 0.0) {
        line.push_str(&format!(
            " · since {}",
            money.signed(input.total - previous)
        ));
    }
    vec![format!("*Net worth:* {}", money.fmt(input.total)), line]
}

fn section_tiers(input: &DigestInput) -> Option<Vec<String>> {
    let values = [input.tiers.store, input.tiers.business, input.tiers.trading];
    let parts: Vec<(usize, f64)> = values
        .iter()
        .enumerate()
        .filter(|(_, v)| **v > 0.0)
        .map(|(i, v)| (i, *v))
        .collect();
    let total: f64 = parts.iter().map(|(_, v)| v).sum();
    // A single tier has no split worth drawing.
    if total <= 0.0 || parts.len() < 2 {
        return None;
    }
    let legend = parts
        .iter()
        .map(|(i, value)| {
            let (_, square, label) = TIER_SQUARES[*i];
            format!("{square} {label} {:.0}%", value / total * 100.0)
        })
        .collect::<Vec<_>>()
        .join(" · ");
    Some(vec![
        "\n🧭 *Allocation*".to_string(),
        tier_bar(&parts, total),
        legend,
    ])
}

fn section_sats(input: &DigestInput, prev: &DigestSnapshot) -> Option<Vec<String>> {
    let price = input.btc_price.filter(|p| *p != 0.0)?;
    let sats = input.btc_sats.filter(|s| *s != 0.0)?;
    if input.btc_usd <= 0.0 {
        return None;
    }
    let denominator = if input.total == 0.0 { 1.0 } else { input.total };
    let mut line = format!(
        "\n🟠 *Stack* {} sats · ₿{:.4} · {:.0}%",
        ksat(sats),
        input.btc_usd / price,
        input.btc_usd / denominator * 100.0
    );
    if let Some(previous) = prev.btc_sats
        && (sats - previous).abs() >= 1.0
    {
        let delta = sats - previous;
        let sign = if delta >= 0.0 { "+" } else { "−" };
        line.push_str(&format!(" · {sign}{}", ksat(delta.abs())));
    }
    Some(vec![line])
}

fn section_borrow(input: &DigestInput, money: &Money) -> Option<Vec<String>> {
    if input.debt <= 0.0 {
        return None;
    }
    let health = match input.hf_min {
        None => "borrow".to_string(),
        Some(hf) => {
            let flag = if hf >= 1.6 {
                ""
            } else if hf >= 1.3 {
                " 🟡"
            } else {
                " 🔴"
            };
            format!("HF {hf:.2}{flag}")
        }
    };
    Some(vec![format!(
        "🛡️ *{health}* · {} debt / {} coll",
        money.fmt(input.debt),
        money.fmt(input.collateral)
    )])
}

fn section_movers(input: &DigestInput, money: &Money) -> Option<Vec<String>> {
    let mut movers: Vec<&Mover> = input
        .movers
        .iter()
        .filter(|m| m.contrib_usd.abs() > 0.5)
        .collect();
    if movers.is_empty() {
        return None;
    }
    // Biggest absolute mover first; stable, so equal movers keep their input order.
    movers.sort_by(|a, b| b.contrib_usd.abs().total_cmp(&a.contrib_usd.abs()));
    let parts = movers
        .iter()
        .take(3)
        .map(|m| {
            let dot = if m.contrib_usd >= 0.0 { "🟢" } else { "🔴" };
            format!(
                "{dot} {} {}",
                strip_markdown(&m.label),
                money.signed(m.contrib_usd)
            )
        })
        .collect::<Vec<_>>()
        .join(" · ");
    Some(vec![format!("*Movers:* {parts}")])
}

fn section_positions(
    input: &DigestInput,
    prev: &DigestSnapshot,
    money: &Money,
    fee_threshold: Option<f64>,
) -> Option<Vec<String>> {
    // Only genuine range-LP positions belong here. Exchange bots arrive through the same array
    // but have no range, so they would render as noise — and they are already in net worth.
    let mut lps: Vec<&PoolLine> = input
        .pools
        .iter()
        .filter(|p| p.in_range.is_some())
        .collect();
    if lps.is_empty() {
        return None;
    }
    let defi_usd: f64 = lps.iter().map(|p| p.usd).sum();
    let out = lps.iter().filter(|p| p.in_range == Some(false)).count();
    let mut head = format!(
        "\n🌊 *DeFi* {} · {}/{} in range · {} fees",
        money.fmt(defi_usd),
        lps.len() - out,
        lps.len(),
        money.fmt(input.claimable)
    );
    if let Some(previous) = prev.claimable
        && (input.claimable - previous).abs() >= 0.01
    {
        head.push_str(&format!(" ({})", money.signed(input.claimable - previous)));
    }

    let mut lines = vec![head];
    lps.sort_by(|a, b| b.usd.total_cmp(&a.usd));
    for (i, pool) in lps.iter().enumerate() {
        let flag = if pool.in_range == Some(true) {
            "✅"
        } else {
            "⚠️"
        };
        let fee = if pool.fees > 0.0 {
            format!(" · {}", money.fmt(pool.fees))
        } else {
            String::new()
        };
        let claim = match fee_threshold {
            Some(threshold) if threshold > 0.0 && pool.fees >= threshold => " 💰",
            _ => "",
        };
        lines.push(format!(
            "{} *{}* {} {} {flag}{fee}{claim}",
            circled(i + 1),
            strip_markdown(&pool.name),
            strip_markdown(&pool.protocol),
            money.fmt(pool.usd)
        ));
    }
    Some(lines)
}

/// Compose the daily brief as Telegram Markdown, or `None` when there is nothing to show.
///
/// Pure: it reads the previous snapshot for deltas but never writes it, so previewing the brief
/// cannot consume the "since last" delta. Only a successful send should advance the snapshot
/// (via [`DigestSnapshot::of`]).
///
/// `date` is the header stamp — see [`header_date`].
pub fn render_digest(
    input: &DigestInput,
    prev: &DigestSnapshot,
    money: &Money,
    date: &str,
    fee_threshold: Option<f64>,
) -> Option<String> {
    if input.total <= 0.0 {
        return None;
    }
    // Order is importance top-down: identity, worth, allocation, the stack, risk, what moved,
    // then the LP ledger.
    let mut lines = vec![format!("📊 *Daily brief* · {date}")];
    lines.extend(section_networth(input, prev, money));
    for section in [
        section_tiers(input),
        section_sats(input, prev),
        section_borrow(input, money),
        section_movers(input, money),
        section_positions(input, prev, money, fee_threshold),
    ]
    .into_iter()
    .flatten()
    {
        lines.extend(section);
    }
    Some(lines.join("\n"))
}

// ===========================================================================
// Once a day
// ===========================================================================

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The brief's header stamp: `%a %d %b`, e.g. `Sat 15 Aug`.
///
/// Spelled out rather than delegated to `strftime` so it is locale-proof — the Python runs under
/// the C locale and the header must not change shape with the host's settings.
pub fn header_date<T: chrono::Datelike>(now: &T) -> String {
    let month = MONTHS[(now.month0() as usize).min(11)];
    format!("{} {:02} {month}", now.weekday(), now.day())
}

/// The day key the "sent already today" latch is stored under: `%Y-%m-%d`, local time.
pub fn day_key<T: chrono::Datelike>(now: &T) -> String {
    format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day())
}

/// Whether the daily brief should go out now.
///
/// Fires when the local clock is inside the configured hour and the brief has not already gone
/// out today — so a poll loop running every 15 minutes sends exactly once. `enabled` is
/// [`crate::telegram::digest_enabled`]; it is a parameter rather than an internal check because
/// this module has no access to credentials, and passing it makes the dependency visible.
pub fn digest_due(
    enabled: bool,
    digest_hour: Option<u32>,
    now_hour: u32,
    today: &str,
    last_sent_day: Option<&str>,
) -> bool {
    enabled && digest_hour == Some(now_hour) && last_sent_day != Some(today)
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::*;

    fn alert(kind: AlertKind) -> Alert {
        Alert {
            key: "base:Aerodrome:64176".to_string(),
            chain: "base".to_string(),
            label: "WETH/USDC · base".to_string(),
            kind,
        }
    }

    // ---------- alert messages ----------

    #[test]
    fn back_in_range_message() {
        assert_eq!(
            render_alert(&alert(AlertKind::BackInRange), None),
            "✅ *Back in range*\nWETH/USDC · base\nEarning fees again."
        );
    }

    #[test]
    fn out_of_range_message_with_and_without_a_band() {
        // No band: the sentence is simply absent, and the message still reads correctly.
        assert_eq!(
            render_alert(&alert(AlertKind::OutOfRange), None),
            "⚠️ *Out of range*\nWETH/USDC · base\nIdle until price returns or you rebalance."
        );
        let below = Edge {
            cur: Some(1800.0),
            lower: Some(2000.0),
            upper: Some(3000.0),
        };
        assert_eq!(
            render_alert(&alert(AlertKind::OutOfRange), Some(&below)),
            "⚠️ *Out of range*\nWETH/USDC · base\nPrice fell 10.0% below your min. Idle until \
             price returns or you rebalance."
        );
        let above = Edge {
            cur: Some(3300.0),
            lower: Some(2000.0),
            upper: Some(3000.0),
        };
        assert!(
            render_alert(&alert(AlertKind::OutOfRange), Some(&above))
                .contains("Price rose 10.0% above your max. ")
        );
    }

    #[test]
    fn an_edge_without_usable_numbers_says_nothing() {
        // In range, or a zero/absent bound: no claim is made.
        for edge in [
            Edge::default(),
            Edge {
                cur: Some(2500.0),
                lower: Some(2000.0),
                upper: Some(3000.0),
            },
            Edge {
                cur: Some(1800.0),
                lower: Some(0.0),
                upper: Some(3000.0),
            },
            Edge {
                cur: Some(0.0),
                lower: Some(2000.0),
                upper: None,
            },
        ] {
            assert_eq!(edge.sentence(), "", "{edge:?} should make no claim");
        }
    }

    #[test]
    fn fees_ready_message() {
        assert_eq!(
            render_alert(
                &alert(AlertKind::FeesReady {
                    fees_usd: 1234.5,
                    threshold: 25.0
                }),
                None
            ),
            "💰 *Fees ready*\nWETH/USDC · base\nUnclaimed fees ≈ $1,234.50 (≥ $25)."
        );
    }

    #[test]
    fn health_factor_message() {
        assert_eq!(
            render_alert(
                &alert(AlertKind::HealthFactorLow {
                    hf: 1.234,
                    threshold: 1.5,
                    debt_usd: 12_345.6,
                    collateral_usd: 45_678.9,
                }),
                None
            ),
            "🛡️ *Health factor low*\nWETH/USDC · base\nHF 1.23 (< 1.50) · $12,346 borrowed \
             against $45,679. Add collateral or repay."
        );
    }

    #[test]
    fn an_on_chain_label_cannot_break_the_message_format() {
        // A pair named with Markdown metacharacters would make Telegram reject the whole
        // request ("can't parse entities") and the alert would never arrive.
        let hostile = Alert {
            label: "*[ETH](https://evil.example)*_x_ · base".to_string(),
            ..alert(AlertKind::BackInRange)
        };
        let message = render_alert(&hostile, None);
        // strip_markdown DELETES metacharacters, so `_x_` collapses to `x` with no space.
        assert!(message.contains("ETHhttps://evil.examplex · base"));
        // Exactly the two asterisks of our own *Back in range* heading survive.
        assert_eq!(message.matches('*').count(), 2);
        assert!(!message.contains('['));
        assert!(!message.contains('_'));
    }

    // ---------- currency ----------

    #[test]
    fn usd_formatting_switches_to_cents_under_a_hundred() {
        let money = Money::usd();
        assert_eq!(money.fmt(1234.56), "$1,235");
        assert_eq!(money.fmt(100.0), "$100");
        assert_eq!(money.fmt(99.994), "$99.99");
        assert_eq!(money.fmt(0.0), "$0.00");
        assert_eq!(money.fmt(-1234.5), "$-1,234");
        assert_eq!(money.signed(1234.5), "+$1,234");
        assert_eq!(money.signed(-1234.5), "−$1,234");
        assert_eq!(money.code(), "usd");
    }

    #[test]
    fn thb_converts_and_keeps_dust_legible() {
        let money = Money::new("thb", Some(34.0));
        assert_eq!(money.code(), "thb");
        assert_eq!(money.fmt(100.0), "฿3,400");
        // Under ฿10 keeps a decimal so a dust fee is not rendered as ฿0.
        assert_eq!(money.fmt(0.2), "฿6.8");
        assert_eq!(money.fmt(0.01), "฿0.3");
        assert_eq!(money.signed(-1.0), "−฿34");
    }

    #[test]
    fn a_missing_rate_falls_back_to_usd_rather_than_lying_in_baht() {
        for money in [
            Money::new("thb", None),
            Money::new("thb", Some(0.0)),
            Money::new("thb", Some(f64::NAN)),
        ] {
            assert_eq!(money.code(), "usd", "a bad rate must demote to USD");
            assert_eq!(money.fmt(100.0), "$100");
        }
        // An unknown currency code also lands on a usable symbol rather than blank.
        assert_eq!(Money::new("eur", Some(0.9)).fmt(100.0), "$90.00");
    }

    // ---------- the brief ----------

    fn sample_input() -> DigestInput {
        DigestInput {
            total: 100_000.0,
            contrib: 2_500.0,
            claimable: 300.0,
            btc_usd: 40_000.0,
            btc_price: Some(100_000.0),
            btc_sats: Some(40_000_000.0),
            debt: 10_000.0,
            collateral: 25_000.0,
            hf_min: Some(1.42),
            tiers: Tiers {
                store: 40_000.0,
                business: 45_000.0,
                trading: 15_000.0,
            },
            movers: vec![
                Mover {
                    label: "BTC".into(),
                    contrib_usd: 1_500.0,
                },
                Mover {
                    label: "PEPE".into(),
                    contrib_usd: -200.0,
                },
                Mover {
                    label: "dust".into(),
                    contrib_usd: 0.4,
                },
            ],
            pools: vec![
                PoolLine {
                    name: "WETH/USDC".into(),
                    protocol: "Aerodrome".into(),
                    usd: 8_000.0,
                    fees: 120.0,
                    in_range: Some(true),
                },
                PoolLine {
                    name: "cbBTC/USDC".into(),
                    protocol: "Aerodrome".into(),
                    usd: 12_000.0,
                    fees: 10.0,
                    in_range: Some(false),
                },
                PoolLine {
                    name: "AI bot".into(),
                    protocol: "KuCoin".into(),
                    usd: 5_000.0,
                    fees: 0.0,
                    in_range: None,
                },
            ],
        }
    }

    #[test]
    fn the_brief_renders_every_section_in_order() {
        let brief = render_digest(
            &sample_input(),
            &DigestSnapshot::default(),
            &Money::usd(),
            "Sat 15 Aug",
            Some(25.0),
        )
        .expect("a funded book renders");
        let lines: Vec<&str> = brief.lines().collect();

        assert_eq!(lines[0], "📊 *Daily brief* · Sat 15 Aug");
        assert_eq!(lines[1], "*Net worth:* $100,000");
        // 2500 on a 97500 base is +2.6%.
        assert_eq!(lines[2], "*24h:* 🟢 +$2,500 (+2.6%)");
        assert_eq!(lines[3], "");
        assert_eq!(lines[4], "🧭 *Allocation*");
        assert_eq!(lines[6], "🟨 Store 40% · 🟩 Business 45% · 🟪 Trading 15%");
        assert!(lines[8].starts_with("🟠 *Stack* 40.00M sats · ₿0.4000 · 40%"));
        assert_eq!(lines[9], "🛡️ *HF 1.42 🟡* · $10,000 debt / $25,000 coll");
        // Sub-50c movers are dropped; the rest rank by absolute size.
        assert_eq!(lines[10], "*Movers:* 🟢 BTC +$1,500 · 🔴 PEPE −$200");
        assert_eq!(lines[12], "🌊 *DeFi* $20,000 · 1/2 in range · $300 fees");
        // Largest position first; the bot (no range) is not in the ledger.
        assert_eq!(lines[13], "① *cbBTC/USDC* Aerodrome $12,000 ⚠️ · $10.00");
        assert_eq!(lines[14], "② *WETH/USDC* Aerodrome $8,000 ✅ · $120 💰");
        assert_eq!(lines.len(), 15, "no stray sections: {brief}");
    }

    #[test]
    fn deltas_appear_only_once_there_is_a_previous_brief() {
        let input = sample_input();
        let prev = DigestSnapshot {
            total: Some(90_000.0),
            claimable: Some(250.0),
            btc_sats: Some(39_000_000.0),
        };
        let brief = render_digest(&input, &prev, &Money::usd(), "Sat 15 Aug", None).unwrap();
        assert!(brief.contains("· since +$10,000"));
        // notify.py:225 `signed` is "+" then fmt(abs(v)), and fmt keeps cents under $100
        // (notify.py:223), so a +50 delta renders "+$50.00", not "+$50".
        assert!(brief.contains("$300 fees (+$50.00)"));
        assert!(
            brief.contains("· +1.00M"),
            "sats stacked since last: {brief}"
        );
        // Without a previous brief, none of those clauses appear at all.
        let first = render_digest(
            &input,
            &DigestSnapshot::default(),
            &Money::usd(),
            "Sat 15 Aug",
            None,
        )
        .unwrap();
        assert!(!first.contains("since"));
        assert!(!first.contains("fees ("));
    }

    #[test]
    fn an_empty_book_produces_no_brief_at_all() {
        for total in [0.0, -1.0] {
            let input = DigestInput {
                total,
                ..Default::default()
            };
            assert_eq!(
                render_digest(
                    &input,
                    &DigestSnapshot::default(),
                    &Money::usd(),
                    "Sat 15 Aug",
                    None
                ),
                None
            );
        }
    }

    #[test]
    fn sections_drop_out_when_they_have_nothing_to_say() {
        let input = DigestInput {
            total: 1_000.0,
            contrib: 0.0,
            tiers: Tiers {
                store: 1_000.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let brief = render_digest(
            &input,
            &DigestSnapshot::default(),
            &Money::usd(),
            "Sat 15 Aug",
            None,
        )
        .unwrap();
        // A single tier has no split worth drawing; no BTC, no debt, no movers, no LPs.
        assert!(!brief.contains("Allocation"));
        assert!(!brief.contains("Stack"));
        assert!(!brief.contains("debt"));
        assert!(!brief.contains("Movers"));
        assert!(!brief.contains("DeFi"));
        assert_eq!(brief.lines().count(), 3);
    }

    #[test]
    fn the_allocation_bar_always_fills_exactly_twelve_cells() {
        let cases = [
            (1.0, 1.0, 1.0),
            (98.0, 1.0, 1.0), // a tiny tier still keeps one cell
            (0.5, 0.5, 99.0),
            (33.3, 33.3, 33.4),
            (1e9, 1.0, 1.0),
        ];
        for (store, business, trading) in cases {
            let input = DigestInput {
                total: store + business + trading,
                tiers: Tiers {
                    store,
                    business,
                    trading,
                },
                ..Default::default()
            };
            let block = section_tiers(&input).expect("three tiers split");
            let bar = &block[1];
            assert_eq!(
                bar.chars().count(),
                BAR_CELLS,
                "bar for {store}/{business}/{trading} was {bar}"
            );
            for (_, square, _) in TIER_SQUARES {
                assert!(
                    bar.contains(square),
                    "a nonzero tier lost its square: {bar}"
                );
            }
        }
    }

    #[test]
    fn a_hostile_pool_name_cannot_break_the_brief() {
        let input = DigestInput {
            total: 1_000.0,
            pools: vec![PoolLine {
                name: "*pwn*".into(),
                protocol: "[x](y)".into(),
                usd: 1_000.0,
                fees: 0.0,
                in_range: Some(true),
            }],
            ..Default::default()
        };
        let brief = render_digest(
            &input,
            &DigestSnapshot::default(),
            &Money::usd(),
            "Sat 15 Aug",
            None,
        )
        .unwrap();
        assert!(brief.contains("① *pwn* xy $1,000 ✅"));
        // Balanced emphasis only: the heading, the section title and one pool name.
        assert!(brief.matches('*').count().is_multiple_of(2));
    }

    // ---------- once a day ----------

    #[test]
    fn the_brief_fires_once_in_its_hour_and_rolls_over_the_next_day() {
        let today = "2026-08-15";
        let tomorrow = "2026-08-16";
        // Inside the hour with nothing sent yet: fire.
        assert!(digest_due(true, Some(9), 9, today, None));
        // Sent already today: the 15-minute poll must not fire again.
        assert!(!digest_due(true, Some(9), 9, today, Some(today)));
        // Later the same hour, still sent: quiet.
        assert!(!digest_due(true, Some(9), 9, today, Some(today)));
        // Next day, same hour: fire again.
        assert!(digest_due(true, Some(9), 9, tomorrow, Some(today)));
        // Wrong hour, and hour 0 must work (it is not "unset").
        assert!(!digest_due(true, Some(9), 8, today, None));
        assert!(!digest_due(true, Some(9), 10, today, None));
        assert!(digest_due(true, Some(0), 0, today, None));
        // Digest off, or delivery not configured: never.
        assert!(!digest_due(true, None, 9, today, None));
        assert!(!digest_due(false, Some(9), 9, today, None));
    }

    #[test]
    fn date_keys_match_pythons_strftime() {
        let day = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        assert_eq!(day_key(&day), "2026-08-15");
        assert_eq!(header_date(&day), "Sat 15 Aug");
        let padded = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        assert_eq!(day_key(&padded), "2026-01-05");
        assert_eq!(header_date(&padded), "Mon 05 Jan");
    }

    #[test]
    fn compact_helpers_match_python() {
        assert_eq!(ksat(1_234_567.0), "1.23M");
        assert_eq!(ksat(45_400.0), "45k");
        assert_eq!(ksat(800.4), "800");
        assert_eq!(circled(1), "①");
        assert_eq!(circled(20), "⑳");
        assert_eq!(circled(21), "21)");
        assert_eq!(grouped(-1234.5, 0), "-1,234");
        assert_eq!(grouped(1234.567, 2), "1,234.57");
        assert_eq!(grouped(999.0, 0), "999");
    }
}
