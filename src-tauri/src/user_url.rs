/// A URL as typed by the user, with a scheme: trimmed, an explicit scheme kept
/// (lowercased, so `Https://` passes the `https://` checks), and a missing one
/// assumed — `http://` for this machine (`localhost`, `127.0.0.1`, `[::1]`,
/// which rarely serve TLS), `https://` for everything else. Path and trailing
/// slashes are left alone: a manifest URL's trailing slash decides how its
/// relative track refs resolve.
pub fn assume_scheme(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    if let Some(len) = scheme_len(url) {
        return format!("{}{}", url[..len].to_ascii_lowercase(), &url[len..]);
    }
    let scheme = if is_loopback_host(url) { "http" } else { "https" };
    format!("{}://{}", scheme, url)
}

/// [`assume_scheme`], then trailing slashes removed so path joins never double
/// a `/`. For base URLs (servers, publish targets), not for manifest URLs.
pub fn normalize_user_url(url: &str) -> String {
    let url = assume_scheme(url);
    // Trim only after the `://`, so a bare `https://` stays recognisable.
    let start = scheme_len(&url).map_or(0, |len| len + 3);
    let rest = url[start..].trim_end_matches('/');
    format!("{}{}", &url[..start], rest)
}

/// Length of a leading `scheme` (RFC 3986: a letter, then letters, digits,
/// `+`, `-`, `.`) followed by `://`. A `://` later in the string — a query
/// parameter holding another URL — is not a scheme.
fn scheme_len(url: &str) -> Option<usize> {
    let end = url.find("://")?;
    let scheme = &url[..end];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
    .then_some(end)
}

/// Whether a scheme-less URL names this machine.
fn is_loopback_host(url: &str) -> bool {
    let authority = url.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = if host_port.starts_with('[') {
        host_port.split(']').next().map(|h| &h[1..]).unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_user_url() {
        assert_eq!(normalize_user_url(" music.example.com/ "), "https://music.example.com");
        assert_eq!(normalize_user_url("192.168.1.5:4533"), "https://192.168.1.5:4533");
        assert_eq!(normalize_user_url("http://nas.local:4533/"), "http://nas.local:4533");
        assert_eq!(normalize_user_url("  https://music.example.com//  "), "https://music.example.com");
        assert_eq!(normalize_user_url("   "), "");
    }

    #[test]
    fn test_a_bare_scheme_is_not_mangled() {
        assert_eq!(normalize_user_url("https://"), "https://");
        assert_eq!(normalize_user_url("https:///"), "https://");
    }

    #[test]
    fn test_only_a_leading_scheme_counts() {
        assert_eq!(
            assume_scheme("example.com/manifest.json?src=https://cdn/x"),
            "https://example.com/manifest.json?src=https://cdn/x"
        );
        assert_eq!(assume_scheme("1http://x"), "https://1http://x");
    }

    #[test]
    fn test_the_scheme_is_lowercased() {
        assert_eq!(normalize_user_url("Https://Music.example.com/"), "https://Music.example.com");
        assert_eq!(assume_scheme("HTTP://x/y/"), "http://x/y/");
    }

    #[test]
    fn test_localhost_assumes_http() {
        assert_eq!(normalize_user_url("localhost:4533/"), "http://localhost:4533");
        assert_eq!(normalize_user_url("LocalHost"), "http://LocalHost");
        assert_eq!(normalize_user_url("127.0.0.1:8080/music"), "http://127.0.0.1:8080/music");
        assert_eq!(normalize_user_url("[::1]:4533"), "http://[::1]:4533");
        assert_eq!(normalize_user_url("localhost.example.com"), "https://localhost.example.com");
        // An explicit scheme still wins.
        assert_eq!(normalize_user_url("https://localhost:4533"), "https://localhost:4533");
    }

    #[test]
    fn test_assume_scheme_keeps_trailing_slashes() {
        assert_eq!(assume_scheme(" host/mix/ "), "https://host/mix/");
        assert_eq!(assume_scheme("https://host/mix/"), "https://host/mix/");
    }
}
