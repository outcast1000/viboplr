//! Signatures for plugins allowed to run in the main realm.
//!
//! A plugin without `"runtime": "worker"` is evaluated in the webview's own JS
//! realm and can do anything the app can (plugins.md → "Trust Model"). Every
//! plugin that can run in a worker is meant to move there; this module is for
//! the ones that can't — today only `vinyl-deck`, because a visualizer is handed
//! a live ShadowRoot and a worker has no DOM.
//!
//! The question it answers is "did Viboplr publish exactly these bytes?". A
//! plugin's id is whatever its manifest says, so an allow-list keyed on the id
//! would hand full access to any side-loaded zip that copied it; a signature
//! can't be copied onto different code.
//!
//! **What is signed** is a small text payload naming the SHA-256 of
//! `manifest.json` and of `index.js` — the manifest because it carries the id
//! (so a signature can't be moved to another plugin's name) and the runtime
//! choice, `index.js` because it is the code the loader evaluates. Other files
//! in a plugin folder (header images) are not code and are not covered.
//! `scripts/plugin-signing.mjs` builds the identical payload on the publishing
//! side; the two must change together (pinned by the fixture test below).
//!
//! **Format** is minisign, the same as the app's own updater, so publishing uses
//! the same `tauri signer sign` tool — but with a **separate key**: the updater
//! key signs app binaries and must never sit in a plugin repo's CI.
//! `signature.sig` at the plugin root holds the base64 `.sig` that tool writes.

use sha2::{Digest, Sha256};
use std::path::Path;

/// File name of the signature inside a plugin folder / release zip.
pub const SIGNATURE_FILE: &str = "signature.sig";

/// Payload header. Bump the version if the payload's shape ever changes, so an
/// old signature can never be read as covering a new layout.
const PAYLOAD_HEADER: &str = "viboplr-plugin-signature:v1";

/// Public keys whose signatures are trusted, as base64 minisign public keys
/// (the same encoding as `plugins.updater.pubkey` in tauri.conf.json). A list
/// so a key can be rotated: ship the new key alongside the old one for a
/// release, re-sign, then drop the old one.
///
/// Not the updater key (`CD75518CAC5EDC4F`): that one signs app binaries. An
/// empty list makes every plugin report `Unsigned`.
pub const TRUSTED_PLUGIN_KEYS: &[&str] = &[
    // Viboplr plugin-signing key, minisign key id D3D9DDD19A8CC4A7 (2026-10-03).
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzRDlEREQxOUE4Q0M0QTcKUldTbnhJeWEwZDNaMDNzbzFqYUMzNHdDMmpyR1ZjTXFnL1prK01jQ1FqU2tYTlg4VnlzUUVxYkMK",
];

/// What the signature check concluded about a plugin folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureStatus {
    /// Signed by a trusted key, over exactly these files.
    Verified,
    /// No signature file. Normal for every plugin today.
    Unsigned,
    /// A signature is present and does not verify: the files changed after
    /// signing, the signature was copied from another plugin, or the key isn't
    /// trusted. Treat it as tampered, never as "unsigned".
    Invalid(String),
}

impl SignatureStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SignatureStatus::Verified => "verified",
            SignatureStatus::Unsigned => "unsigned",
            SignatureStatus::Invalid(_) => "invalid",
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// The exact bytes a plugin signature covers. Mirrors `payload()` in
/// scripts/plugin-signing.mjs.
pub fn signing_payload(manifest: &[u8], code: &[u8]) -> String {
    format!(
        "{}\nmanifest.json sha256={}\nindex.js sha256={}\n",
        PAYLOAD_HEADER,
        sha256_hex(manifest),
        sha256_hex(code)
    )
}

fn decode_b64_text(what: &str, b64: &str) -> Result<String, String> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("{} is not base64: {}", what, e))?;
    String::from_utf8(raw).map_err(|_| format!("{} is not UTF-8", what))
}

/// Verify `signature_b64` (the contents of `signature.sig`) over the payload for
/// these files against any of `keys`.
pub fn verify_with_keys(manifest: &[u8], code: &[u8], signature_b64: &str, keys: &[&str]) -> SignatureStatus {
    if keys.is_empty() {
        return SignatureStatus::Invalid("this build trusts no plugin-signing key".to_string());
    }
    let sig_text = match decode_b64_text("signature", signature_b64) {
        Ok(t) => t,
        Err(e) => return SignatureStatus::Invalid(e),
    };
    let signature = match minisign_verify::Signature::decode(&sig_text) {
        Ok(s) => s,
        Err(e) => return SignatureStatus::Invalid(format!("malformed signature: {}", e)),
    };
    let payload = signing_payload(manifest, code);
    let mut last_error = String::new();
    for key in keys {
        let key_text = match decode_b64_text("public key", key) {
            Ok(t) => t,
            Err(e) => {
                last_error = e;
                continue;
            }
        };
        let public_key = match minisign_verify::PublicKey::decode(&key_text) {
            Ok(k) => k,
            Err(e) => {
                last_error = format!("malformed public key: {}", e);
                continue;
            }
        };
        // `false` = no legacy signatures: only the prehashed (BLAKE2b-512) form,
        // which is what `tauri signer` writes. scripts/plugin-signing.mjs
        // `verifySignature` applies the same rule.
        match public_key.verify(payload.as_bytes(), &signature, false) {
            Ok(()) => return SignatureStatus::Verified,
            Err(e) => last_error = e.to_string(),
        }
    }
    SignatureStatus::Invalid(format!("signature does not verify: {}", last_error))
}

/// Signature status of a plugin folder whose manifest and code were already
/// read, so the check covers exactly the bytes the loader is handed. `code` is
/// `None` when the scan skipped `index.js` (a disabled plugin); it is then read
/// here, and only if there is a signature to check.
pub fn verify_scanned(dir: &Path, manifest: &[u8], code: Option<&str>) -> SignatureStatus {
    // A build that trusts no key can verify nothing, so a signed plugin is
    // simply unsigned to it — not "invalid", which would refuse it as tampered.
    // This is the state until the plugin-signing key is baked in, and it keeps
    // a signed release loading on an app that predates its key.
    if TRUSTED_PLUGIN_KEYS.is_empty() {
        return SignatureStatus::Unsigned;
    }
    let signature = match std::fs::read_to_string(dir.join(SIGNATURE_FILE)) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SignatureStatus::Unsigned,
        Err(e) => return SignatureStatus::Invalid(format!("cannot read {}: {}", SIGNATURE_FILE, e)),
    };
    let read;
    let code_bytes: &[u8] = match code {
        Some(c) => c.as_bytes(),
        None => match std::fs::read(dir.join("index.js")) {
            Ok(b) => {
                read = b;
                &read
            }
            Err(e) => return SignatureStatus::Invalid(format!("cannot read index.js: {}", e)),
        },
    };
    verify_with_keys(manifest, code_bytes, &signature, TRUSTED_PLUGIN_KEYS)
}

/// The fields a plugin listing carries about its signature.
pub fn status_json(status: &SignatureStatus) -> (serde_json::Value, serde_json::Value) {
    let error = match status {
        SignatureStatus::Invalid(reason) => serde_json::Value::String(reason.clone()),
        _ => serde_json::Value::Null,
    };
    (serde_json::Value::String(status.as_str().to_string()), error)
}

#[cfg(test)]
fn verify_plugin_dir_with_keys(dir: &Path, keys: &[&str]) -> SignatureStatus {
    let sig_path = dir.join(SIGNATURE_FILE);
    let signature = match std::fs::read_to_string(&sig_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SignatureStatus::Unsigned,
        Err(e) => return SignatureStatus::Invalid(format!("cannot read {}: {}", SIGNATURE_FILE, e)),
    };
    let manifest = match std::fs::read(dir.join("manifest.json")) {
        Ok(b) => b,
        Err(e) => return SignatureStatus::Invalid(format!("cannot read manifest.json: {}", e)),
    };
    // A signed plugin with no code is not something a release produces.
    let code = match std::fs::read(dir.join("index.js")) {
        Ok(b) => b,
        Err(e) => return SignatureStatus::Invalid(format!("cannot read index.js: {}", e)),
    };
    verify_with_keys(&manifest, &code, &signature, keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway keypair made with `tauri signer generate --ci -p ""` for these
    // tests only; it is not, and must never become, a trusted key.
    const TEST_PUBKEY: &str = include_str!("../tests/fixtures/plugin-signing/test.key.pub");
    const FIXTURE_MANIFEST: &[u8] = include_bytes!("../tests/fixtures/plugin-signing/plugin/manifest.json");
    const FIXTURE_CODE: &[u8] = include_bytes!("../tests/fixtures/plugin-signing/plugin/index.js");
    const FIXTURE_SIG: &str = include_str!("../tests/fixtures/plugin-signing/plugin/signature.sig");
    // A second throwaway key, to prove an untrusted signer is refused.
    const OTHER_PUBKEY: &str = include_str!("../tests/fixtures/plugin-signing/other.key.pub");

    fn keys() -> Vec<&'static str> {
        vec![TEST_PUBKEY.trim()]
    }

    #[test]
    fn test_payload_matches_the_publishing_script() {
        // Built by `node scripts/plugin-signing.mjs payload` over the fixture;
        // if this fails the two sides disagree and no signature will verify.
        let expected = include_str!("../tests/fixtures/plugin-signing/plugin.payload.txt");
        assert_eq!(signing_payload(FIXTURE_MANIFEST, FIXTURE_CODE), expected);
    }

    #[test]
    fn test_a_signed_plugin_verifies() {
        assert_eq!(
            verify_with_keys(FIXTURE_MANIFEST, FIXTURE_CODE, FIXTURE_SIG, &keys()),
            SignatureStatus::Verified
        );
    }

    #[test]
    fn test_changed_code_is_invalid_not_unsigned() {
        let mut code = FIXTURE_CODE.to_vec();
        code.extend_from_slice(b"\n// injected\n");
        assert!(matches!(
            verify_with_keys(FIXTURE_MANIFEST, &code, FIXTURE_SIG, &keys()),
            SignatureStatus::Invalid(_)
        ));
    }

    #[test]
    fn test_a_signature_cannot_be_moved_to_another_id() {
        // Same code, manifest renamed: the manifest hash is in the payload.
        let manifest = String::from_utf8(FIXTURE_MANIFEST.to_vec())
            .unwrap()
            .replace("signing-fixture", "vinyl-deck");
        assert!(matches!(
            verify_with_keys(manifest.as_bytes(), FIXTURE_CODE, FIXTURE_SIG, &keys()),
            SignatureStatus::Invalid(_)
        ));
    }

    #[test]
    fn test_an_untrusted_key_is_refused() {
        assert!(matches!(
            verify_with_keys(FIXTURE_MANIFEST, FIXTURE_CODE, FIXTURE_SIG, &[OTHER_PUBKEY.trim()]),
            SignatureStatus::Invalid(_)
        ));
    }

    #[test]
    fn test_any_trusted_key_may_sign_during_rotation() {
        assert_eq!(
            verify_with_keys(FIXTURE_MANIFEST, FIXTURE_CODE, FIXTURE_SIG, &[OTHER_PUBKEY.trim(), TEST_PUBKEY.trim()]),
            SignatureStatus::Verified
        );
    }

    #[test]
    fn test_no_trusted_keys_means_nothing_verifies() {
        assert!(matches!(
            verify_with_keys(FIXTURE_MANIFEST, FIXTURE_CODE, FIXTURE_SIG, &[]),
            SignatureStatus::Invalid(_)
        ));
    }

    #[test]
    fn test_garbage_signature_is_invalid() {
        assert!(matches!(
            verify_with_keys(FIXTURE_MANIFEST, FIXTURE_CODE, "not base64 !!", &keys()),
            SignatureStatus::Invalid(_)
        ));
    }

    #[test]
    fn test_folder_without_signature_is_unsigned() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("manifest.json"), FIXTURE_MANIFEST).unwrap();
        std::fs::write(dir.path().join("index.js"), FIXTURE_CODE).unwrap();
        assert_eq!(verify_plugin_dir_with_keys(dir.path(), &keys()), SignatureStatus::Unsigned);
    }

    #[test]
    fn test_signed_folder_verifies_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("manifest.json"), FIXTURE_MANIFEST).unwrap();
        std::fs::write(dir.path().join("index.js"), FIXTURE_CODE).unwrap();
        std::fs::write(dir.path().join(SIGNATURE_FILE), FIXTURE_SIG).unwrap();
        assert_eq!(verify_plugin_dir_with_keys(dir.path(), &keys()), SignatureStatus::Verified);
    }

    #[test]
    fn test_every_trusted_key_is_a_valid_minisign_public_key() {
        // A mangled paste would otherwise surface only as every signed plugin
        // reading "invalid" in the field.
        assert!(!TRUSTED_PLUGIN_KEYS.is_empty());
        for key in TRUSTED_PLUGIN_KEYS {
            let text = decode_b64_text("public key", key).expect("base64 of the .pub file");
            minisign_verify::PublicKey::decode(&text).expect("a minisign public key");
        }
    }

    #[test]
    fn test_the_updater_key_is_not_a_plugin_key() {
        let updater = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENENzU1MThDQUM1RURDNEYKUldSUDNGNnNqRkYxemV6SnJNeHJBcldOTVpxcjdkRTFYNDFmVFdralhvUWNSNTArenBwNXV1aFcK";
        assert!(!TRUSTED_PLUGIN_KEYS.contains(&updater));
    }

    #[test]
    fn test_the_test_key_is_not_trusted() {
        assert!(!TRUSTED_PLUGIN_KEYS.contains(&TEST_PUBKEY.trim()));
    }
}
