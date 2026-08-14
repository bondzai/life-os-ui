//! `/api/search` — port of `api/src/routes/search.ts`, a keyless DuckDuckGo-lite proxy.
//!
//! The frontend cannot scrape DDG itself (CORS), so the server does it and returns parsed results.
//!
//! **This route is unauthenticated**, matching `api/src/index.ts:54`, which mounts `searchRoutes`
//! without `jwtMiddleware()` while every other route group gets it. Anyone who can reach the port
//! can run web searches through this box. Preserved as-is because changing it would be a
//! behavioural change the client did not ask for — but it is worth deciding on deliberately.

use axum::Json;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::LazyLock;

const MAX_RESULTS: usize = 8;
const USER_AGENT: &str = "Lyra/1.0 (Life OS)";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

/// `GET /api/search?q=`
pub async fn search(Query(params): Query<SearchQuery>) -> Response {
    let Some(query) = params.q.filter(|q| !q.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing query parameter \"q\"" })),
        )
            .into_response();
    };

    match fetch_ddg(&query).await {
        Ok(html) => {
            Json(json!({ "query": query, "results": parse_ddg_lite(&html) })).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "Search error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Search failed", "results": [] })),
            )
                .into_response()
        }
    }
}

async fn fetch_ddg(query: &str) -> anyhow::Result<String> {
    let url = format!("https://lite.duckduckgo.com/lite/?q={}", urlencode(query));
    let response = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("DDG returned {}", response.status().as_u16());
    }
    Ok(response.text().await?)
}

/// `encodeURIComponent` — everything outside the unreserved set is percent-encoded.
fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Captures a whole anchor — attributes and inner text — so the `class` and `href` attributes can
/// be inspected in **either order**.
///
/// **Deviation from search.ts, deliberate.** Its `linkRegex` is
/// `<a[^>]*class="result-link"[^>]*href="([^"]*)"`, which requires `class` to precede `href`.
/// DDG emits `href` first — as the comment directly above that regex documents — and `[^>]*`
/// cannot cross the closing `>`, so the pattern never matches. Every result therefore falls
/// through to the looser fallback pass, which yields no snippets. Matching either order restores
/// the snippets the endpoint was always meant to return; the response shape is unchanged.
static ANCHOR_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<a([^>]*)>(.*?)</a>").unwrap());
static HREF_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"(?i)href="([^"]*)""#).unwrap());
static SNIPPET_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?is)<td[^>]*class="result-snippet"[^>]*>(.*?)</td>"#).unwrap()
});
static TAG_RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<[^>]*>").unwrap());
static SIMPLE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"(?is)<a[^>]*href="(https?://[^"]*)"[^>]*>([^<]+)</a>"#).unwrap()
});

/// Pairs links with snippets positionally, then falls back to a looser pattern when the
/// class-based markup finds nothing — same two-pass strategy as `parseDDGLite`.
pub fn parse_ddg_lite(html: &str) -> Vec<SearchResult> {
    let links: Vec<(String, String)> = ANCHOR_RE
        .captures_iter(html)
        .filter_map(|caps| {
            let attrs = caps.get(1)?.as_str();
            if !attrs.contains("result-link") {
                return None;
            }
            let url = HREF_RE
                .captures(attrs)?
                .get(1)?
                .as_str()
                .replace("&amp;", "&");
            let title = strip_tags(caps.get(2)?.as_str());
            // Relative hrefs are DDG's own navigation, not results.
            (!url.is_empty() && !title.is_empty() && !url.starts_with('/')).then_some((url, title))
        })
        .collect();

    let snippets: Vec<String> = SNIPPET_RE
        .captures_iter(html)
        .filter_map(|caps| {
            let snippet = strip_tags(caps.get(1)?.as_str());
            (!snippet.is_empty()).then_some(snippet)
        })
        .collect();

    let mut results: Vec<SearchResult> = links
        .iter()
        .take(MAX_RESULTS)
        .enumerate()
        .map(|(i, (url, title))| SearchResult {
            title: title.clone(),
            url: url.clone(),
            snippet: snippets.get(i).cloned().unwrap_or_default(),
        })
        .collect();

    if results.is_empty() {
        for caps in SIMPLE_RE.captures_iter(html) {
            if results.len() >= MAX_RESULTS {
                break;
            }
            let (Some(url), Some(title)) = (caps.get(1), caps.get(2)) else {
                continue;
            };
            let title = title.as_str().trim().to_string();
            if title.chars().count() > 10 && !url.as_str().contains("duckduckgo.com") {
                results.push(SearchResult {
                    title,
                    url: url.as_str().to_string(),
                    snippet: String::new(),
                });
            }
        }
    }

    results
}

fn strip_tags(input: &str) -> String {
    TAG_RE.replace_all(input, "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links_and_pairs_them_with_snippets() {
        let html = r#"
          <a rel="nofollow" href="https://example.com/a" class="result-link">First <b>hit</b></a>
          <td class="result-snippet">About the first thing.</td>
          <a rel="nofollow" href="https://example.com/b" class="result-link">Second</a>
          <td class="result-snippet">About the second.</td>
        "#;
        let results = parse_ddg_lite(html);
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0].title, "First hit",
            "inner tags should be stripped"
        );
        assert_eq!(results[0].url, "https://example.com/a");
        assert_eq!(results[0].snippet, "About the first thing.");
        assert_eq!(results[1].snippet, "About the second.");
    }

    #[test]
    fn unescapes_ampersands_in_urls() {
        let html =
            r#"<a href="https://example.com/?a=1&amp;b=2" class="result-link">Title here</a>"#;
        assert_eq!(parse_ddg_lite(html)[0].url, "https://example.com/?a=1&b=2");
    }

    #[test]
    fn skips_relative_navigation_links() {
        let html = r#"<a href="/settings" class="result-link">Settings</a>"#;
        assert!(parse_ddg_lite(html).is_empty());
    }

    #[test]
    fn a_link_without_a_snippet_gets_an_empty_one() {
        let html = r#"<a href="https://example.com/a" class="result-link">Only link</a>"#;
        let results = parse_ddg_lite(html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].snippet, "");
    }

    #[test]
    fn falls_back_to_plain_anchors_when_the_markup_changes() {
        // No result-link classes at all — the fallback pass should still find something.
        let html = r#"<a href="https://example.com/long-page">A sufficiently long title</a>
                      <a href="https://duckduckgo.com/about">Ignore me please</a>
                      <a href="https://example.com/x">short</a>"#;
        let results = parse_ddg_lite(html);
        assert_eq!(results.len(), 1, "{results:?}");
        assert_eq!(results[0].title, "A sufficiently long title");
    }

    #[test]
    fn attribute_order_does_not_matter() {
        // DDG emits href-then-class; search.ts's regex only matched class-then-href and so
        // never fired. Both orders must parse.
        let href_first =
            r#"<a rel="nofollow" href="https://example.com/a" class="result-link">Title</a>"#;
        let class_first = r#"<a class="result-link" href="https://example.com/a">Title</a>"#;
        assert_eq!(parse_ddg_lite(href_first).len(), 1);
        assert_eq!(parse_ddg_lite(class_first).len(), 1);
        assert_eq!(parse_ddg_lite(href_first), parse_ddg_lite(class_first));
    }

    #[test]
    fn an_ordinary_anchor_without_the_class_is_not_a_result() {
        let html = r#"<a href="https://example.com/nav">Some navigation link</a>
                      <a href="https://example.com/a" class="result-link">Real result</a>"#;
        let results = parse_ddg_lite(html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Real result");
    }

    #[test]
    fn caps_results_at_eight() {
        let html = (0..20)
            .map(|i| {
                format!(r#"<a href="https://example.com/{i}" class="result-link">Result {i}</a>"#)
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(parse_ddg_lite(&html).len(), MAX_RESULTS);
    }

    #[test]
    fn urlencode_matches_encode_uri_component() {
        assert_eq!(urlencode("hello world"), "hello%20world");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("caf\u{e9}"), "caf%C3%A9");
        assert_eq!(urlencode("safe-_.!~*'()"), "safe-_.!~*'()");
    }
}
