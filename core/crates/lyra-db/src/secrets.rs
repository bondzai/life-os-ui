//! Sealing a credential that has to live in the database.
//!
//! A Discord webhook URL *is* the credential — its last path segment is a token, and anyone holding
//! the URL can post to that channel. Until now every credential lived in `.env.local`, mode 600,
//! and the database held none, which is exactly why the nightly `VACUUM INTO` backups can be copied
//! offsite without a second thought.
//!
//! Configuring a webhook from the UI means the URL has to be stored. Stored in the clear, fourteen
//! nightly backup files and the offsite copy would each become a live credential, and that
//! reclassification would happen silently — nobody would notice the day the backups started
//! mattering. Sealing keeps the old property: `.env.local` holds the key, the database holds
//! ciphertext, and a leaked backup is inert.
//!
//! ## What this is not
//!
//! It is not protection against someone who has the box. The key is on the same machine, in a file
//! the service can read; anyone who can read `.env.local` can unseal everything. That is not the
//! threat being addressed. The threat is a **copy of the database leaving the box** — a backup, an
//! offsite sync, a file handed to a tool — which is a thing that happens routinely and by design,
//! and which should not be a credential leak.
//!
//! ## Format
//!
//! `v1.<base64url nonce>.<base64url ciphertext‖tag>`, versioned so the algorithm can change without
//! guessing at what an old row was sealed with.
//!
//! The channel's id is bound in as additional authenticated data, so a sealed secret cannot be
//! copied from one row to another: unsealing it under a different id fails rather than quietly
//! posting one room's message to another room's webhook.

use anyhow::{Context, Result, anyhow, bail};
use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;

/// Where the sealing key comes from. Base64, 32 bytes decoded.
pub const KEY_VAR: &str = "LYRA_SECRET_KEY";

const PREFIX: &str = "v1";

/// The key, read from the environment.
///
/// `None` rather than an error when it is unset, because that is a legitimate state: a box that has
/// never configured a channel from the UI needs no key, and demanding one would make the whole app
/// refuse to start over a feature nobody had used. Callers that need to seal say so themselves,
/// with a message naming the variable.
pub fn key_from_env() -> Option<Vec<u8>> {
    // The name is written out here as a literal, not as `KEY_VAR`, and that is deliberate:
    // `the_install_script_forwards_every_setting_the_server_reads` finds settings by matching
    // `env::var("LITERAL")`, so reading through a constant makes the variable invisible to the one
    // guard that would otherwise have caught it missing from `ops/service-env.list`. It was
    // invisible exactly once, which is how this comment came to exist.
    // `the_constant_and_the_literal_agree` below keeps the two from drifting.
    let raw = std::env::var("LYRA_SECRET_KEY").ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match B64
        .decode(raw)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(raw))
    {
        // 32 bytes, because AES-256. A short key is a typo, not a weaker key, so it is refused
        // rather than padded.
        Ok(bytes) if bytes.len() == 32 => Some(bytes),
        _ => {
            tracing::error!(
                var = KEY_VAR,
                "ignoring a key that is not 32 base64-decoded bytes — generate one with \
                 `openssl rand -base64 32`"
            );
            None
        }
    }
}

fn cipher(key: &[u8]) -> Result<LessSafeKey> {
    let unbound = UnboundKey::new(&AES_256_GCM, key)
        .map_err(|_| anyhow!("the sealing key is not a valid AES-256 key"))?;
    Ok(LessSafeKey::new(unbound))
}

/// Seal `plaintext` for the row identified by `bound_to`.
pub fn seal(key: &[u8], bound_to: &str, plaintext: &str) -> Result<String> {
    let cipher = cipher(key)?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    aws_lc_rs::rand::fill(&mut nonce_bytes).map_err(|_| anyhow!("no randomness available"))?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut buffer = plaintext.as_bytes().to_vec();
    cipher
        .seal_in_place_append_tag(nonce, Aad::from(bound_to.as_bytes()), &mut buffer)
        .map_err(|_| anyhow!("sealing failed"))?;

    Ok(format!(
        "{PREFIX}.{}.{}",
        B64.encode(nonce_bytes),
        B64.encode(&buffer)
    ))
}

/// Unseal a value produced by [`seal`] for the same `bound_to`.
///
/// Every failure returns the same shape of error on purpose: which part went wrong — bad key, wrong
/// id, tampered ciphertext — is not information a caller acts on differently, and a message that
/// distinguished them would be an oracle.
pub fn unseal(key: &[u8], bound_to: &str, sealed: &str) -> Result<String> {
    let mut parts = sealed.split('.');
    let version = parts.next().unwrap_or_default();
    if version != PREFIX {
        bail!("this value was sealed by a version this build does not know ({version:?})");
    }
    let nonce_b64 = parts.next().context("a sealed value needs a nonce")?;
    let body_b64 = parts.next().context("a sealed value needs a body")?;

    let nonce_bytes: [u8; NONCE_LEN] = B64
        .decode(nonce_b64)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .context("could not unseal")?;
    let mut buffer = B64.decode(body_b64).context("could not unseal")?;

    let cipher = cipher(key)?;
    let plaintext = cipher
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(bound_to.as_bytes()),
            &mut buffer,
        )
        .map_err(|_| anyhow!("could not unseal"))?;

    String::from_utf8(plaintext.to_vec()).context("could not unseal")
}

/// What the UI is allowed to see: enough to recognise which webhook this is, never enough to use it.
///
/// A Discord URL looks like `https://discord.com/api/webhooks/<id>/<token>`. The id identifies the
/// room and is not a secret; the token is the whole credential. So the id is shown, and of the token
/// only the last four characters — enough to tell two rooms apart when both are called "alerts",
/// and useless to anyone who reads it.
pub fn preview(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let Some((head, token)) = trimmed.rsplit_once('/') else {
        return "••••".to_string();
    };
    let tail: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    // A token shorter than the tail we would show is not previewed at all — showing "••••abcd" of a
    // four-character token shows the whole thing.
    if token.chars().count() <= 8 {
        return format!("{head}/••••");
    }
    format!("{head}/••••{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = &[7u8; 32];
    const URL: &str = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz";

    #[test]
    fn the_constant_and_the_literal_agree() {
        // `key_from_env` reads a literal so the allowlist guard can see it; every message uses
        // `KEY_VAR`. This is what stops those two being different strings.
        assert_eq!(KEY_VAR, "LYRA_SECRET_KEY");
    }

    #[test]
    fn a_sealed_value_round_trips() {
        let sealed = seal(KEY, "chan-1", URL).unwrap();
        assert!(sealed.starts_with("v1."));
        assert!(
            !sealed.contains("abcdefgh"),
            "the token must not survive in the sealed form: {sealed}"
        );
        assert_eq!(unseal(KEY, "chan-1", &sealed).unwrap(), URL);
    }

    #[test]
    fn a_secret_cannot_be_moved_to_another_channel() {
        // The binding is the point. Without it, copying one row's sealed column into another row
        // would send that room's messages to this room's webhook, and nothing would object.
        let sealed = seal(KEY, "chan-1", URL).unwrap();
        assert!(unseal(KEY, "chan-2", &sealed).is_err());
    }

    #[test]
    fn a_wrong_key_or_a_tampered_body_fails_the_same_way() {
        let sealed = seal(KEY, "chan-1", URL).unwrap();
        assert!(unseal(&[9u8; 32], "chan-1", &sealed).is_err());

        // Flip the last base64 character of the body.
        let mut parts: Vec<&str> = sealed.split('.').collect();
        let body = parts.pop().unwrap().to_string();
        let mut chars: Vec<char> = body.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
        let tampered = format!(
            "{}.{}",
            parts.join("."),
            chars.into_iter().collect::<String>()
        );
        assert!(unseal(KEY, "chan-1", &tampered).is_err());
    }

    #[test]
    fn two_seals_of_one_value_differ() {
        // A fresh nonce each time, so a reader of two backups cannot tell that the webhook did not
        // change between them.
        assert_ne!(
            seal(KEY, "chan-1", URL).unwrap(),
            seal(KEY, "chan-1", URL).unwrap()
        );
    }

    #[test]
    fn an_unknown_version_is_refused_rather_than_guessed() {
        assert!(unseal(KEY, "chan-1", "v2.aaaa.bbbb").is_err());
        assert!(unseal(KEY, "chan-1", "not-sealed-at-all").is_err());
    }

    #[test]
    fn a_preview_identifies_the_room_and_reveals_no_token() {
        let shown = preview(URL);
        assert_eq!(
            shown,
            "https://discord.com/api/webhooks/1234567890/••••wxyz"
        );
        assert!(!shown.contains("abcdef"), "the token body must not appear");

        // A short token is masked entirely rather than mostly shown.
        assert_eq!(preview("https://x.test/a/abcd"), "https://x.test/a/••••");
        assert_eq!(preview("nonsense"), "••••");
    }
}
