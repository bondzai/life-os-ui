//! `lyra-analytics` — pure analytics over a portfolio snapshot.
//!
//! Port of the `pow_mcp/` package: tier drift, exposure unwrapping, HHI concentration, and the
//! `{value, confidence, data_gaps}` honesty envelope. The rule that makes this layer worth
//! trusting: a metric the keyless snapshot cannot support comes back null-with-reason, never
//! estimated.
