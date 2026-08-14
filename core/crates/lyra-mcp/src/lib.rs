//! `lyra-mcp` — Model Context Protocol server over `lyra-analytics`.
//!
//! Port of `mcp_server.py`. Read-only by construction: the server refuses to start if any
//! signing secret is present in the environment, and every "action" it returns is a proposal
//! plus a deep link the user follows themselves.
pub mod server;
pub mod tools;
