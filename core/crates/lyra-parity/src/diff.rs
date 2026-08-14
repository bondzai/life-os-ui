//! Structural JSON diff for Python-vs-Rust endpoint parity.
//!
//! The rules encode what "the same answer" means for a portfolio API:
//!
//! * **Keys are exact.** A field the Python oracle returns and Rust does not is a hard failure —
//!   that is a dropped position or a dropped metric, the failure mode this harness exists to catch.
//! * **Floats get a relative tolerance, integers do not.** Money crosses the float→`Decimal`/`U256`
//!   boundary in the port, so USD values are allowed to drift a fraction of a percent. Integers are
//!   *identities* here — `tokenId`, `tick`, `decimals`, `chainId`, epoch stamps — where "within
//!   0.5%" would mean a different position, so they must match exactly.
//! * **Arrays match by identity when they can.** Both sides fan out concurrently, so array order is
//!   not meaningful; comparing index-wise would produce noise that trains you to ignore the report.

use serde_json::Value;
use std::collections::BTreeMap;

/// Keys tried, in order, when deciding how to line up two arrays of objects.
const IDENTITY_KEYS: [&str; 6] = ["id", "tokenId", "token_id", "address", "symbol", "name"];

#[derive(Debug, Clone)]
pub struct DiffOpts {
    /// Allowed relative drift for non-integer numbers (0.005 = 0.5%).
    pub rel_tolerance: f64,
    /// Values whose magnitudes are both below this count as equal, so 1e-18 dust does not
    /// register as "infinite% drift" against 0.
    pub abs_epsilon: f64,
    /// Paths to skip — volatile things like `updated` timestamps and elapsed-time counters.
    pub ignore: Vec<String>,
    /// Treat fields present only in the Rust response as a failure.
    pub strict_extra: bool,
}

impl Default for DiffOpts {
    fn default() -> Self {
        Self {
            rel_tolerance: 0.005,
            abs_epsilon: 1e-9,
            ignore: Vec::new(),
            strict_extra: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    MissingInRust,
    ExtraInRust,
    TypeChanged,
    NumberDrift,
    ValueChanged,
    ArrayLength,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::MissingInRust => "missing in rust",
            Kind::ExtraInRust => "extra in rust",
            Kind::TypeChanged => "type changed",
            Kind::NumberDrift => "number drift",
            Kind::ValueChanged => "value changed",
            Kind::ArrayLength => "array length",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Mismatch {
    pub kind: Kind,
    pub path: String,
    pub detail: String,
}

#[derive(Debug, Default)]
pub struct Report {
    pub mismatches: Vec<Mismatch>,
    /// Scalar leaves compared — a sanity check that the harness actually walked the payload
    /// rather than silently comparing two empty objects.
    pub compared: usize,
    pub max_drift: f64,
    pub max_drift_path: String,
}

impl Report {
    pub fn is_green(&self) -> bool {
        self.mismatches.is_empty()
    }

    fn push(&mut self, kind: Kind, path: &str, detail: String) {
        self.mismatches.push(Mismatch {
            kind,
            path: path.to_string(),
            detail,
        });
    }
}

pub fn diff(python: &Value, rust: &Value, opts: &DiffOpts) -> Report {
    let mut report = Report::default();
    walk("$", python, rust, opts, &mut report);
    report
}

fn walk(path: &str, py: &Value, rs: &Value, opts: &DiffOpts, out: &mut Report) {
    if is_ignored(path, &opts.ignore) {
        return;
    }
    match (py, rs) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, pv) in a {
                let child = format!("{path}.{key}");
                match b.get(key) {
                    Some(rv) => walk(&child, pv, rv, opts, out),
                    None => {
                        if !is_ignored(&child, &opts.ignore) {
                            out.push(
                                Kind::MissingInRust,
                                &child,
                                format!("python had {}", preview(pv)),
                            );
                        }
                    }
                }
            }
            if opts.strict_extra {
                for (key, rv) in b {
                    if a.contains_key(key) {
                        continue;
                    }
                    let child = format!("{path}.{key}");
                    if !is_ignored(&child, &opts.ignore) {
                        out.push(
                            Kind::ExtraInRust,
                            &child,
                            format!("rust had {}", preview(rv)),
                        );
                    }
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => diff_arrays(path, a, b, opts, out),
        (Value::Number(_), Value::Number(_)) => {
            out.compared += 1;
            diff_numbers(path, py, rs, opts, out);
        }
        (Value::String(a), Value::String(b)) => {
            out.compared += 1;
            if a != b {
                out.push(Kind::ValueChanged, path, format!("python={a:?} rust={b:?}"));
            }
        }
        (Value::Bool(a), Value::Bool(b)) => {
            out.compared += 1;
            if a != b {
                out.push(Kind::ValueChanged, path, format!("python={a} rust={b}"));
            }
        }
        (Value::Null, Value::Null) => out.compared += 1,
        _ => {
            out.compared += 1;
            out.push(
                Kind::TypeChanged,
                path,
                format!("python={} rust={}", type_name(py), type_name(rs)),
            );
        }
    }
}

fn diff_numbers(path: &str, py: &Value, rs: &Value, opts: &DiffOpts, out: &mut Report) {
    // Integers are identities, not quantities — exact or nothing.
    if is_integer(py) && is_integer(rs) {
        if py != rs {
            out.push(
                Kind::ValueChanged,
                path,
                format!("python={py} rust={rs} (integers compare exactly)"),
            );
        }
        return;
    }

    let (a, b) = match (py.as_f64(), rs.as_f64()) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            out.push(
                Kind::TypeChanged,
                path,
                format!("python={py} rust={rs} (unrepresentable)"),
            );
            return;
        }
    };

    if a.abs() <= opts.abs_epsilon && b.abs() <= opts.abs_epsilon {
        return;
    }

    let scale = a.abs().max(b.abs());
    let drift = if scale == 0.0 {
        0.0
    } else {
        (a - b).abs() / scale
    };

    if drift > out.max_drift {
        out.max_drift = drift;
        out.max_drift_path = path.to_string();
    }
    if drift > opts.rel_tolerance {
        out.push(
            Kind::NumberDrift,
            path,
            format!(
                "python={a} rust={b} ({:.3}% > {:.3}%)",
                drift * 100.0,
                opts.rel_tolerance * 100.0
            ),
        );
    }
}

fn diff_arrays(path: &str, a: &[Value], b: &[Value], opts: &DiffOpts, out: &mut Report) {
    if let Some(key) = identity_key(a, b) {
        let pa = index_by(a, key);
        let pb = index_by(b, key);
        for (id, pv) in &pa {
            let child = format!("{path}[{id}]");
            match pb.get(id) {
                Some(rv) => walk(&child, pv, rv, opts, out),
                None => out.push(
                    Kind::MissingInRust,
                    &child,
                    format!("no rust item with {key}={id:?}"),
                ),
            }
        }
        if opts.strict_extra {
            for id in pb.keys() {
                if !pa.contains_key(id) {
                    out.push(
                        Kind::ExtraInRust,
                        &format!("{path}[{id}]"),
                        format!("rust has an extra item with {key}={id:?}"),
                    );
                }
            }
        }
        return;
    }

    if a.len() != b.len() {
        out.push(
            Kind::ArrayLength,
            path,
            format!("python={} rust={}", a.len(), b.len()),
        );
    }
    for (i, (pv, rv)) in a.iter().zip(b.iter()).enumerate() {
        walk(&format!("{path}[{i}]"), pv, rv, opts, out);
    }
}

/// A key usable for lining up two arrays: present on every element of both sides, scalar, and
/// unique within each side. Without uniqueness the pairing would be arbitrary, which is worse
/// than falling back to index order.
fn identity_key(a: &[Value], b: &[Value]) -> Option<&'static str> {
    if a.is_empty() || b.is_empty() {
        return None;
    }
    IDENTITY_KEYS
        .into_iter()
        .find(|&key| usable_identity(a, key) && usable_identity(b, key))
}

fn usable_identity(items: &[Value], key: &str) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            return false;
        };
        let Some(value) = obj.get(key) else {
            return false;
        };
        let repr = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return false,
        };
        if !seen.insert(repr) {
            return false; // duplicate — cannot pair unambiguously
        }
    }
    true
}

fn index_by<'a>(items: &'a [Value], key: &str) -> BTreeMap<String, &'a Value> {
    items
        .iter()
        .filter_map(|item| {
            let value = item.get(key)?;
            let repr = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            Some((repr, item))
        })
        .collect()
}

/// A bare name (`updated`) ignores that field wherever it appears; anything containing `.` or `[`
/// is matched against the whole path with array subscripts normalised to `[]`, so
/// `$.positions[].fees_usd` covers every element.
fn is_ignored(path: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let normalized = normalize(path);
    let last = path.rsplit('.').next().unwrap_or(path);
    patterns.iter().any(|raw| {
        let pattern = raw.trim();
        if pattern.contains('.') || pattern.contains('[') {
            let want = normalize(pattern.strip_prefix("$.").unwrap_or(pattern));
            normalized == want
                || normalized
                    .strip_prefix("$.")
                    .map(|p| p == want)
                    .unwrap_or(false)
        } else {
            last == pattern
        }
    })
}

fn normalize(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut depth = 0usize;
    for ch in path.chars() {
        match ch {
            '[' => {
                depth += 1;
                out.push('[');
            }
            ']' if depth > 0 => {
                depth -= 1;
                out.push(']');
            }
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn is_integer(v: &Value) -> bool {
    v.is_i64() || v.is_u64()
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn preview(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 80 {
        let head: String = s.chars().take(77).collect();
        format!("{head}...")
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report(py: Value, rs: Value) -> Report {
        diff(&py, &rs, &DiffOpts::default())
    }

    #[test]
    fn identical_payloads_are_green() {
        let r = report(
            json!({"usd": 1234.5, "sym": "ETH"}),
            json!({"usd": 1234.5, "sym": "ETH"}),
        );
        assert!(r.is_green(), "{:?}", r.mismatches);
        assert_eq!(r.compared, 2);
    }

    #[test]
    fn float_drift_inside_tolerance_passes_and_is_recorded() {
        // 0.2% — the float→Decimal noise the tolerance exists to absorb.
        let r = report(json!({"usd": 1000.0}), json!({"usd": 1002.0}));
        assert!(r.is_green(), "{:?}", r.mismatches);
        assert!(
            r.max_drift > 0.0019 && r.max_drift < 0.0021,
            "drift {}",
            r.max_drift
        );
        assert_eq!(r.max_drift_path, "$.usd");
    }

    #[test]
    fn float_drift_outside_tolerance_fails() {
        let r = report(json!({"usd": 1000.0}), json!({"usd": 1200.0}));
        assert_eq!(r.mismatches.len(), 1);
        assert_eq!(r.mismatches[0].kind, Kind::NumberDrift);
    }

    #[test]
    fn integers_get_no_tolerance() {
        // A tokenId 0.05% off is a different position, not a rounding difference.
        let r = report(json!({"tokenId": 482913}), json!({"tokenId": 482914}));
        assert_eq!(r.mismatches.len(), 1);
        assert_eq!(r.mismatches[0].kind, Kind::ValueChanged);
    }

    #[test]
    fn missing_field_is_reported() {
        let r = report(json!({"usd": 1.0, "fees_usd": 2.0}), json!({"usd": 1.0}));
        assert_eq!(r.mismatches.len(), 1);
        assert_eq!(r.mismatches[0].kind, Kind::MissingInRust);
        assert_eq!(r.mismatches[0].path, "$.fees_usd");
    }

    #[test]
    fn extra_field_is_reported_when_strict() {
        let r = report(json!({"usd": 1.0}), json!({"usd": 1.0, "surprise": true}));
        assert_eq!(r.mismatches.len(), 1);
        assert_eq!(r.mismatches[0].kind, Kind::ExtraInRust);
    }

    #[test]
    fn arrays_pair_by_id_regardless_of_order() {
        let py = json!({"positions": [{"id": "a", "usd": 10.0}, {"id": "b", "usd": 20.0}]});
        let rs = json!({"positions": [{"id": "b", "usd": 20.0}, {"id": "a", "usd": 10.0}]});
        assert!(report(py, rs).is_green());
    }

    #[test]
    fn array_pairing_catches_a_dropped_position() {
        let py = json!({"positions": [{"id": "a", "usd": 10.0}, {"id": "b", "usd": 20.0}]});
        let rs = json!({"positions": [{"id": "a", "usd": 10.0}]});
        let r = report(py, rs);
        assert_eq!(r.mismatches.len(), 1);
        assert_eq!(r.mismatches[0].kind, Kind::MissingInRust);
        assert_eq!(r.mismatches[0].path, "$.positions[b]");
    }

    #[test]
    fn arrays_without_usable_identity_fall_back_to_index() {
        let r = report(json!([1.0, 2.0, 3.0]), json!([1.0, 2.0]));
        assert!(r.mismatches.iter().any(|m| m.kind == Kind::ArrayLength));
    }

    #[test]
    fn duplicate_identity_values_fall_back_to_index() {
        // Two items sharing an id cannot be paired unambiguously.
        let py = json!([{"id": "a", "usd": 1.0}, {"id": "a", "usd": 2.0}]);
        let rs = json!([{"id": "a", "usd": 1.0}, {"id": "a", "usd": 2.0}]);
        assert!(report(py, rs).is_green());
    }

    #[test]
    fn near_zero_dust_does_not_register_as_infinite_drift() {
        let r = report(json!({"usd": 0.0}), json!({"usd": 1e-12}));
        assert!(r.is_green(), "{:?}", r.mismatches);
    }

    #[test]
    fn zero_against_a_real_value_still_fails() {
        let r = report(json!({"usd": 0.0}), json!({"usd": 25.0}));
        assert_eq!(r.mismatches.len(), 1);
        assert_eq!(r.mismatches[0].kind, Kind::NumberDrift);
    }

    #[test]
    fn type_change_is_reported() {
        let r = report(json!({"usd": 1.0}), json!({"usd": "1.0"}));
        assert_eq!(r.mismatches[0].kind, Kind::TypeChanged);
    }

    #[test]
    fn bare_name_ignore_matches_any_depth() {
        let opts = DiffOpts {
            ignore: vec!["updated".into()],
            ..Default::default()
        };
        let py = json!({"updated": 1, "inner": {"updated": 2, "usd": 1.0}});
        let rs = json!({"updated": 9, "inner": {"updated": 8, "usd": 1.0}});
        assert!(diff(&py, &rs, &opts).is_green());
    }

    #[test]
    fn path_ignore_covers_every_array_element() {
        let opts = DiffOpts {
            ignore: vec!["$.positions[].fees_usd".into()],
            ..Default::default()
        };
        let py = json!({"positions": [{"id": "a", "fees_usd": 1.0}, {"id": "b", "fees_usd": 2.0}]});
        let rs = json!({"positions": [{"id": "a", "fees_usd": 9.0}, {"id": "b", "fees_usd": 8.0}]});
        assert!(diff(&py, &rs, &opts).is_green());
    }

    #[test]
    fn ignoring_one_field_does_not_ignore_its_siblings() {
        let opts = DiffOpts {
            ignore: vec!["updated".into()],
            ..Default::default()
        };
        let py = json!({"updated": 1, "usd": 100.0});
        let rs = json!({"updated": 9, "usd": 500.0});
        assert_eq!(diff(&py, &rs, &opts).mismatches.len(), 1);
    }

    #[test]
    fn nested_structures_report_full_paths() {
        let py = json!({"chains": {"base": {"defi": [{"id": "x", "usd": 100.0}]}}});
        let rs = json!({"chains": {"base": {"defi": [{"id": "x", "usd": 300.0}]}}});
        let r = report(py, rs);
        assert_eq!(r.mismatches[0].path, "$.chains.base.defi[x].usd");
    }
}
