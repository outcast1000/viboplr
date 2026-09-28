//! Content-Security-Policy for the worker plugin runtime
//! (`src/pluginWorker/runtime.ts`, see `host.ts` for the design).
//!
//! A worker takes its CSP from **its own script's response**, not from the page
//! that created it, and the app page has no CSP (`app.security.csp` is null). So
//! a worker-runtime plugin could still reach the network through dynamic
//! `import("https://…")`, which is syntax and can't be deleted from the worker
//! scope the way `fetch` is. Putting this header on the worker script blocks
//! that, plus any other fetch the worker might attempt, while leaving the main
//! page's policy exactly as it was.
//!
//! Tauri only lets a response header be set per request through a window
//! builder's `on_web_resource_request`, which is why `main` is built in code
//! (from its `tauri.conf.json` entry, `"create": false`) instead of by config.
//! In `tauri dev` the page loads from the Vite server, which never goes through
//! that hook, so `vite.config.ts` sets the same header from the same file.

use std::borrow::Cow;

/// Shared with `vite.config.ts`, which reads the same file for the dev server.
pub const WORKER_CSP: &str = include_str!("../plugin-worker-csp.txt");

/// Built worker bundles are named by `vite.config.ts` → `worker.rollupOptions`.
const WORKER_ASSET_PREFIX: &str = "/assets/plugin-worker-";

/// `on_web_resource_request` handler: tag the worker runtime script, nothing else.
pub fn apply_csp(request: tauri::http::Request<Vec<u8>>, response: &mut tauri::http::Response<Cow<'static, [u8]>>) {
    if is_worker_script(request.uri().path()) {
        if let Ok(value) = tauri::http::HeaderValue::from_str(WORKER_CSP.trim()) {
            response.headers_mut().insert("Content-Security-Policy", value);
        }
    }
}

fn is_worker_script(path: &str) -> bool {
    path.starts_with(WORKER_ASSET_PREFIX) && path.ends_with(".js")
}

/// The hosts a worker-runtime plugin's `network:<host>` permissions grant, as
/// sent by the frontend bridge to every command that fetches a plugin-supplied
/// URL (`plugin_fetch`, `plugin_files_download`, `plugin_cache_image`).
///
/// The bridge already checks the URL a plugin asks for, but reqwest follows
/// redirects here in Rust, where that check can't see them — so without this a
/// plugin granted `network:lrclib.net` could reach any host through an open
/// redirect on an allowed one. `None` means "no scope" (main-realm plugins,
/// whose behavior is unchanged); an empty list allows nothing.
///
/// Patterns match exactly like `isGranted` in `src/pluginWorker/permissions.ts`:
/// an exact hostname, `*.example.com` for subdomains only, or `*` for any host.
#[derive(Debug, Clone)]
pub struct NetworkScope(Vec<String>);

/// Redirects followed within an allowed scope; reqwest's own default is 10.
const MAX_REDIRECTS: usize = 10;

impl NetworkScope {
    pub fn from_arg(allowed_hosts: Option<Vec<String>>) -> Option<Self> {
        allowed_hosts.map(|hosts| Self(hosts.into_iter().map(|h| h.to_ascii_lowercase()).collect()))
    }

    pub fn allows(&self, url: &reqwest::Url) -> bool {
        if url.scheme() != "http" && url.scheme() != "https" {
            return false;
        }
        let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
            return false;
        };
        self.0.iter().any(|pattern| host_matches(pattern, &host))
    }

    /// Reject the request up front when its own URL is outside the scope.
    pub fn check(&self, url: &str) -> Result<(), String> {
        let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
        if self.allows(&parsed) {
            Ok(())
        } else {
            Err(format!("{} is outside this plugin's network permission", parsed.host_str().unwrap_or(url)))
        }
    }

    /// Follow redirects only while they stay inside the scope. A hop outside it
    /// is not followed: the caller gets the 3xx response itself (with its
    /// `Location`), so a plugin can still see that it was redirected — which is
    /// how the ISP-block-page detection `plugin_fetch` reports `url` for keeps
    /// working — without the bytes ever being fetched from the other host.
    pub fn redirect_policy(self) -> reqwest::redirect::Policy {
        reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if self.allows(attempt.url()) {
                attempt.follow()
            } else {
                log::warn!("plugin fetch: not following redirect to {} (outside the plugin's network permission)", attempt.url());
                attempt.stop()
            }
        })
    }
}

fn host_matches(pattern: &str, host: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return host.len() > suffix.len() + 1 && host.ends_with(suffix) && host[..host.len() - suffix.len()].ends_with('.');
    }
    pattern == host
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_worker_bundle_is_tagged() {
        assert!(is_worker_script("/assets/plugin-worker-B1x9.js"));
        assert!(!is_worker_script("/assets/index-B1x9.js"));
        assert!(!is_worker_script("/index.html"));
        assert!(!is_worker_script("/assets/plugin-worker-B1x9.js.map"));
    }

    fn scope(hosts: &[&str]) -> NetworkScope {
        NetworkScope::from_arg(Some(hosts.iter().map(|h| h.to_string()).collect())).unwrap()
    }

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn network_scope_matches_like_the_frontend_gate() {
        let s = scope(&["lrclib.net", "*.deezer.com"]);
        assert!(s.allows(&url("https://lrclib.net/api/get")));
        assert!(s.allows(&url("https://LRCLIB.net/x")), "hosts compare case-insensitively");
        assert!(s.allows(&url("https://api.deezer.com/x")));
        assert!(!s.allows(&url("https://deezer.com/x")), "*. is subdomains only");
        assert!(!s.allows(&url("https://notdeezer.com/x")));
        assert!(!s.allows(&url("https://evil.net/x")));
        assert!(!s.allows(&url("file:///etc/passwd")));
        assert!(scope(&["*"]).allows(&url("http://anything.io/")));
        assert!(!scope(&[]).allows(&url("https://lrclib.net/")), "an empty scope allows nothing");
        assert!(NetworkScope::from_arg(None).is_none(), "no scope = main-realm plugin, unchanged");
    }

    #[test]
    fn network_scope_rejects_an_out_of_scope_request_up_front() {
        let s = scope(&["lrclib.net"]);
        assert!(s.check("https://lrclib.net/api").is_ok());
        assert!(s.check("https://example.com/").unwrap_err().contains("example.com"));
        assert!(s.check("not a url").is_err());
    }

    /// End to end against a real socket: an in-scope redirect is followed, an
    /// out-of-scope one is handed back as the 3xx instead of being fetched.
    #[test]
    fn redirects_are_followed_only_inside_the_scope() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // One server answering on "127.0.0.1" (allowed) and reachable as
        // "localhost" (not allowed): /hop redirects to the allowed name,
        // /escape redirects to the disallowed one.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let resp = match path.as_str() {
                    "/hop" => format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                    "/escape" => format!("HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                    _ => "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nfinal".to_string(),
                };
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let client = reqwest::Client::builder()
                .redirect(scope(&["127.0.0.1"]).redirect_policy())
                .build()
                .unwrap();
            let followed = client.get(format!("http://127.0.0.1:{port}/hop")).send().await.unwrap();
            assert_eq!(followed.status().as_u16(), 200);
            assert_eq!(followed.text().await.unwrap(), "final");

            let stopped = client.get(format!("http://127.0.0.1:{port}/escape")).send().await.unwrap();
            assert_eq!(stopped.status().as_u16(), 302, "the redirect is returned, not followed");
            assert!(stopped.headers()["location"].to_str().unwrap().contains("localhost"));
        });
    }

    #[test]
    fn policy_blocks_network_but_allows_the_runtime() {
        let csp = WORKER_CSP.trim();
        assert!(tauri::http::HeaderValue::from_str(csp).is_ok(), "must be a valid header value");
        // The runtime evaluates plugin source with `new Function`.
        assert!(csp.contains("script-src 'self' 'unsafe-eval'"));
        assert!(csp.contains("connect-src 'none'"));
        // WebKit checks a module worker's own static imports against
        // worker-src, not script-src — 'none' here stops the runtime booting.
        assert!(csp.contains("worker-src 'self'"));
        assert!(!csp.contains("https:") && !csp.contains('*'), "no remote source may be allowed");
    }
}
