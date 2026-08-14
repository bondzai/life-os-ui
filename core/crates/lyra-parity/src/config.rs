//! `parity.toml` — which endpoints to compare, and how strictly.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// The Python oracle, e.g. `http://127.0.0.1:8000`.
    pub python_base: String,
    /// The Rust port under test, e.g. `http://127.0.0.1:3001`.
    pub rust_base: String,

    #[serde(default = "default_tolerance")]
    pub rel_tolerance: f64,
    #[serde(default = "default_epsilon")]
    pub abs_epsilon: f64,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,

    /// Applied to every endpoint, on top of each endpoint's own list.
    #[serde(default)]
    pub ignore: Vec<String>,

    #[serde(default)]
    pub python_headers: BTreeMap<String, String>,
    #[serde(default)]
    pub rust_headers: BTreeMap<String, String>,

    #[serde(default, rename = "endpoint")]
    pub endpoints: Vec<Endpoint>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub name: String,
    /// Path used on both sides unless overridden — the Rust port remounts the wealth surface
    /// under `/api/wealth/*`, so most entries override `rust_path`.
    pub path: Option<String>,
    pub python_path: Option<String>,
    pub rust_path: Option<String>,
    #[serde(default)]
    pub ignore: Vec<String>,
    pub rel_tolerance: Option<f64>,
}

fn default_tolerance() -> f64 {
    0.005
}
fn default_epsilon() -> f64 {
    1e-9
}
fn default_timeout_secs() -> u64 {
    120
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut cfg: Config =
            toml::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;

        cfg.python_base = expand_env(&cfg.python_base)?;
        cfg.rust_base = expand_env(&cfg.rust_base)?;
        for value in cfg
            .python_headers
            .values_mut()
            .chain(cfg.rust_headers.values_mut())
        {
            *value = expand_env(value)?;
        }
        for endpoint in &cfg.endpoints {
            if endpoint.resolve_python().is_none() {
                anyhow::bail!(
                    "endpoint {:?} needs either `path` or `python_path`",
                    endpoint.name
                );
            }
        }
        Ok(cfg)
    }
}

impl Endpoint {
    pub fn resolve_python(&self) -> Option<&str> {
        self.python_path.as_deref().or(self.path.as_deref())
    }

    pub fn resolve_rust(&self) -> Option<&str> {
        self.rust_path.as_deref().or(self.path.as_deref())
    }
}

/// Expands `${VAR}` so secrets (a JWT for the Rust side, a wallet list) live in the environment
/// rather than in a file that gets committed.
fn expand_env(input: &str) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find('}')
            .with_context(|| format!("unterminated ${{...}} in {input:?}"))?;
        let name = &after[..end];
        let value = std::env::var(name)
            .with_context(|| format!("environment variable {name} is referenced but not set"))?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_a_set_variable() {
        unsafe { std::env::set_var("LYRA_PARITY_TEST_TOKEN", "abc123") };
        assert_eq!(
            expand_env("Bearer ${LYRA_PARITY_TEST_TOKEN}").unwrap(),
            "Bearer abc123"
        );
    }

    #[test]
    fn missing_variable_is_an_error_not_an_empty_string() {
        // Silently expanding to "" would send an unauthenticated request and report a
        // 401-vs-200 diff instead of the real problem.
        assert!(expand_env("${LYRA_PARITY_DEFINITELY_UNSET}").is_err());
    }

    #[test]
    fn leaves_plain_strings_alone() {
        assert_eq!(
            expand_env("http://127.0.0.1:8000").unwrap(),
            "http://127.0.0.1:8000"
        );
    }

    #[test]
    fn endpoint_path_falls_back_to_shared_path() {
        let e = Endpoint {
            name: "x".into(),
            path: Some("/api/sentiment".into()),
            python_path: None,
            rust_path: Some("/api/wealth/sentiment".into()),
            ignore: vec![],
            rel_tolerance: None,
        };
        assert_eq!(e.resolve_python(), Some("/api/sentiment"));
        assert_eq!(e.resolve_rust(), Some("/api/wealth/sentiment"));
    }
}
