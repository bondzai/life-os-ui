//! `lyra-parity` — the gate the Rust port has to pass.
//!
//! Runs the same requests against the Python oracle (`wallet-portfolio/server.py`) and the Rust
//! port, and diffs the JSON. An endpoint is "ported" when this is green for it; until then the
//! Python implementation stays the source of truth.
//!
//! With no endpoints configured it exits 0 — the gate exists before there is anything to gate,
//! so wiring it into CI does not have to wait for the first port.

mod config;
mod diff;

use anyhow::{Context, Result};
use clap::Parser;
use config::{Config, Endpoint};
use diff::{DiffOpts, Report};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(
    name = "lyra-parity",
    about = "Diff the Rust port against the Python oracle"
)]
struct Args {
    #[arg(short, long, default_value = "parity.toml")]
    config: PathBuf,

    /// Compare only endpoints whose name contains this substring.
    #[arg(short, long)]
    only: Option<String>,

    /// Override the relative tolerance for every endpoint (0.005 = 0.5%).
    #[arg(short = 't', long)]
    tolerance: Option<f64>,

    /// Do not fail on fields present only in the Rust response.
    #[arg(long)]
    allow_extra: bool,

    /// Mismatches printed per endpoint before truncating.
    #[arg(long, default_value_t = 20)]
    max_report: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let cfg = Config::load(&args.config)?;

    let selected: Vec<&Endpoint> = cfg
        .endpoints
        .iter()
        .filter(|e| {
            args.only
                .as_ref()
                .is_none_or(|needle| e.name.contains(needle))
        })
        .collect();

    if selected.is_empty() {
        if cfg.endpoints.is_empty() {
            println!(
                "no endpoints configured in {} — nothing to compare yet",
                args.config.display()
            );
        } else {
            println!(
                "no endpoint matched --only {:?}",
                args.only.unwrap_or_default()
            );
        }
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_secs))
        .build()?;
    let python_headers = build_headers(&cfg.python_headers)?;
    let rust_headers = build_headers(&cfg.rust_headers)?;

    println!("python : {}", cfg.python_base);
    println!("rust   : {}", cfg.rust_base);
    println!();

    let mut failures = 0usize;

    for endpoint in selected {
        let opts = DiffOpts {
            rel_tolerance: args
                .tolerance
                .or(endpoint.rel_tolerance)
                .unwrap_or(cfg.rel_tolerance),
            abs_epsilon: cfg.abs_epsilon,
            ignore: cfg
                .ignore
                .iter()
                .chain(endpoint.ignore.iter())
                .cloned()
                .collect(),
            strict_extra: !args.allow_extra,
        };

        let py_path = endpoint.resolve_python().expect("validated at load");
        let rs_path = endpoint.resolve_rust().unwrap_or(py_path);

        let py = fetch(&client, &cfg.python_base, py_path, &python_headers).await;
        let rs = fetch(&client, &cfg.rust_base, rs_path, &rust_headers).await;

        match (py, rs) {
            (Ok(py), Ok(rs)) => {
                let report = diff::diff(&py, &rs, &opts);
                print_report(&endpoint.name, &report, opts.rel_tolerance, args.max_report);
                if !report.is_green() {
                    failures += 1;
                }
            }
            (py, rs) => {
                // A transport failure is not a diff — say which side broke, so a stopped
                // oracle is never mistaken for a porting bug.
                println!("✗ {}", endpoint.name);
                if let Err(e) = py {
                    println!("    python request failed: {e:#}");
                }
                if let Err(e) = rs {
                    println!("    rust request failed:   {e:#}");
                }
                println!();
                failures += 1;
            }
        }
    }

    if failures == 0 {
        println!("parity: green");
        Ok(())
    } else {
        println!("parity: {failures} endpoint(s) failed");
        std::process::exit(1);
    }
}

async fn fetch(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    headers: &HeaderMap,
) -> Result<Value> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let response = client
        .get(&url)
        .headers(headers.clone())
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .with_context(|| format!("reading body of {url}"))?;
    if !status.is_success() {
        anyhow::bail!("GET {url} returned {status}: {}", truncate(&body, 200));
    }
    serde_json::from_str(&body)
        .with_context(|| format!("GET {url} returned non-JSON: {}", truncate(&body, 200)))
}

fn build_headers(raw: &BTreeMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (key, value) in raw {
        headers.insert(
            HeaderName::from_bytes(key.as_bytes())
                .with_context(|| format!("header name {key:?}"))?,
            HeaderValue::from_str(value).with_context(|| format!("header value for {key:?}"))?,
        );
    }
    Ok(headers)
}

fn print_report(name: &str, report: &Report, tolerance: f64, max_report: usize) {
    if report.is_green() {
        println!(
            "✓ {name}  ({} values, max drift {:.3}% of {:.3}% allowed)",
            report.compared,
            report.max_drift * 100.0,
            tolerance * 100.0
        );
        if report.compared == 0 {
            println!("    warning: compared 0 values — is this endpoint returning an empty body?");
        }
        return;
    }

    println!(
        "✗ {name}  ({} mismatches, {} values compared)",
        report.mismatches.len(),
        report.compared
    );
    for mismatch in report.mismatches.iter().take(max_report) {
        println!("    [{}] {}", mismatch.kind.label(), mismatch.path);
        println!("        {}", mismatch.detail);
    }
    if report.mismatches.len() > max_report {
        println!("    ... {} more", report.mismatches.len() - max_report);
    }
    println!();
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "..."
    }
}
