//! `lyra-alerts` — alert rules, digests, and delivery.
//!
//! Port of `notify.py` (974 LOC) and `tgbot.py`. State lives in the `alert_state` table rather
//! than a temp JSON file, so dedup survives a restart. Alerts fan out to both Telegram and
//! Lyra's in-app notification store.
pub mod config;
pub mod digest;
pub mod message;
pub mod rules;
pub mod state;
pub mod telegram;
