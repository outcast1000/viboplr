//! Reference resolution for shareable bundles (Option C — see
//! `SHAREABLE-BUNDLES-PLAN.md`).
//!
//! A bundle track names its audio via a `src` that is either a **relative path**
//! (resolved against the bundle's container base) or an **absolute URL**. This
//! module is the single place that (a) tells the two apart and (b) resolves a
//! subscribed source's `src` into a concrete, fetchable URL — enforcing the
//! reader-side security guardrails.
//!
//! Mixtape (ZIP) refs are always relative and resolved in-archive by the
//! extractor, so they don't pass through here; only the hosted/subscribe path
//! needs URL resolution.

/// Does `src` carry a URL scheme (`scheme:` / `scheme://`)? Per RFC 3986 a scheme
/// is `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` followed by `:`. If so the ref
/// is **absolute**; otherwise it's a **relative** path resolved against the base.
///
/// Note: root-relative (`/x`) and protocol-relative (`//h/x`) have no scheme, so
/// they read as relative and are handled by RFC-3986 join against the base.
pub fn is_absolute_ref(src: &str) -> bool {
    let bytes = src.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    for (i, &c) in bytes.iter().enumerate() {
        if c == b':' {
            return i > 0;
        }
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'-' || c == b'.') {
            return false;
        }
    }
    false
}

/// Resolve a subscribed source track's `src` into a fetchable absolute URL.
///
/// - Absolute refs pass through unchanged.
/// - Relative refs are RFC-3986-joined against `base_url` (the URL the manifest
///   was fetched from), e.g. `https://h/a/manifest.json` + `tracks/x.mp3`
///   → `https://h/a/tracks/x.mp3`.
///
/// Returns `None` — so the caller **drops** the track — when the ref can't be
/// resolved, or when the resolved value isn't `http(s)`. This is the security
/// guardrail: a subscribed manifest must never make the app read `file://` off
/// the user's disk or dial a private `subsonic://` endpoint. Only http/https are
/// ever fetched.
pub fn resolve_subscribe_ref(base_url: &str, src: &str) -> Option<String> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return None;
    }
    let resolved = if is_absolute_ref(trimmed) {
        trimmed.to_string()
    } else {
        reqwest::Url::parse(base_url).ok()?.join(trimmed).ok()?.to_string()
    };
    let lower = resolved.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(resolved)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_absolute_ref() {
        assert!(is_absolute_ref("https://cdn/x.mp3"));
        assert!(is_absolute_ref("http://cdn/x.mp3"));
        assert!(is_absolute_ref("subsonic://c/1"));
        assert!(is_absolute_ref("file:///etc/passwd"));
        // Relative forms:
        assert!(!is_absolute_ref("tracks/01-x.flac"));
        assert!(!is_absolute_ref("/tracks/x.mp3")); // root-relative
        assert!(!is_absolute_ref("//host/x.mp3")); // protocol-relative
        assert!(!is_absolute_ref(""));
        assert!(!is_absolute_ref("./a.mp3"));
    }

    #[test]
    fn test_absolute_passthrough() {
        assert_eq!(
            resolve_subscribe_ref("https://h/a/manifest.json", "https://cdn.example.com/x.mp3"),
            Some("https://cdn.example.com/x.mp3".to_string())
        );
    }

    #[test]
    fn test_relative_join_against_manifest_dir() {
        assert_eq!(
            resolve_subscribe_ref("https://h/a/manifest.json", "tracks/x.mp3"),
            Some("https://h/a/tracks/x.mp3".to_string())
        );
        // A query string on the manifest URL doesn't leak into the join.
        assert_eq!(
            resolve_subscribe_ref("https://h/a/manifest.json?v=2", "tracks/x.mp3"),
            Some("https://h/a/tracks/x.mp3".to_string())
        );
        // Parent traversal resolves normally.
        assert_eq!(
            resolve_subscribe_ref("https://h/a/b/manifest.json", "../x.mp3"),
            Some("https://h/a/x.mp3".to_string())
        );
    }

    #[test]
    fn test_guardrail_drops_non_http() {
        // A subscribed manifest must not make us read local files or dial private schemes.
        assert_eq!(resolve_subscribe_ref("https://h/a/manifest.json", "file:///etc/passwd"), None);
        assert_eq!(resolve_subscribe_ref("https://h/a/manifest.json", "subsonic://c/1"), None);
        assert_eq!(resolve_subscribe_ref("https://h/a/manifest.json", ""), None);
    }
}
