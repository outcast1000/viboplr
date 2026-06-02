use serde::Serialize;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
struct BrowseWindowMessage {
    label: String,
    msg_type: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct BrowseWindowNavigation {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct BrowseWindowClosed {
    label: String,
}

/// Open a secondary webview window that loads an external URL.
/// An initialization script injects `window.__viboplr.send(type, data)` so
/// injected scraping code can send results back to the main app via IPC.
#[tauri::command]
pub async fn open_browse_window(
    app: tauri::AppHandle,
    url: String,
    label: String,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    visible: Option<bool>,
) -> Result<(), String> {
    // Close existing window with same label if any
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    // Browse windows exist only to scrape (and occasionally log in) — they must
    // never emit sound. This gate is unconditional: there is no scenario where a
    // hidden scrape window should play audio.
    //
    // ROOT CAUSE: wry creates the WKWebView with autoplay unlocked
    // (`setMediaTypesRequiringUserActionForPlayback(None)` — wry's default, which
    // Tauri 2.11 gives no builder knob to override and clobbers even a custom
    // WKWebViewConfiguration). A *normal* browser rejects un-gestured playback
    // with NotAllowedError, so Spotify's "resume last session" attempt silently
    // fails and the page stays quiet on a manual open. Here that gate is gone, so
    // the page's own play() succeeds and audio leaks out — the scraper never asks
    // for playback, the relaxed policy just lets the page do what browsers forbid.
    //
    // FIX (prevention, not muting): re-impose the browser's autoplay policy in JS.
    // Reject media-element play() that isn't tied to a genuine user gesture
    // (rejecting with NotAllowedError, exactly as WebKit would) and keep Web Audio
    // contexts suspended until a gesture occurs. This reproduces the manual-open
    // behavior — playback simply never starts — instead of letting it start and
    // masking it. A real user gesture (login click in a visible window) flips the
    // gate so legitimate interaction still works.
    // Injected into ALL frames — Spotify's player lives in subframes that a
    // main-frame-only script would miss.
    let autoplay_gate_script =
        r#"(function() {
    // Track whether a real user gesture has happened (matches the browser's
    // "sticky activation" concept). Until then, autoplay is denied.
    var gestured = false;
    ['pointerdown','mousedown','touchstart','keydown'].forEach(function(t) {
        document.addEventListener(t, function() { gestured = true; }, true);
    });
    try {
        var proto = HTMLMediaElement.prototype;
        var nativePlay = proto.play;
        // Re-create the browser's gate: un-gestured play() rejects with
        // NotAllowedError. Pages (including Spotify) are built to handle this —
        // they catch it and stay paused, so nothing plays and nothing breaks.
        proto.play = function() {
            if (!gestured) {
                try { this.pause(); } catch(e) {}
                return Promise.reject(new DOMException(
                    'play() blocked: no user activation (viboplr scrape window)',
                    'NotAllowedError'));
            }
            return nativePlay.apply(this, arguments);
        };
        // Belt-and-suspenders: if anything still manages to start (e.g. an
        // autoplay attribute honored before our hook), pause it on the play event.
        document.addEventListener('play', function(e) {
            if (!gestured && e.target && typeof e.target.pause === 'function') {
                try { e.target.pause(); } catch(err) {}
            }
        }, true);
    } catch(e) {
        console.error('[viboplr-bridge] failed to install autoplay gate:', e);
    }
    try {
        // Spotify can route audio through Web Audio, which bypasses element
        // playback. Keep every context suspended until a real gesture; resume()
        // is a no-op without activation, mirroring the browser policy.
        var ACtor = window.AudioContext || window.webkitAudioContext;
        if (ACtor) {
            var nativeResume = ACtor.prototype.resume;
            ACtor.prototype.resume = function() {
                if (!gestured) return Promise.resolve();
                return nativeResume.apply(this, arguments);
            };
            var Wrapped = function() {
                var ctx = new (Function.prototype.bind.apply(
                    ACtor, [null].concat([].slice.call(arguments))))();
                if (!gestured) { try { ctx.suspend(); } catch(e) {} }
                return ctx;
            };
            Wrapped.prototype = ACtor.prototype;
            window.AudioContext = Wrapped;
            window.webkitAudioContext = Wrapped;
        }
    } catch(e) {
        console.error('[viboplr-bridge] failed to gate web audio:', e);
    }
})();"#;

    let init_script = format!(
        r#"(function() {{
    window.__viboplr = {{
        _label: '{}',
        send: function(type, data) {{
            if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {{
                try {{
                    window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                        event: 'browse-window-message',
                        payload: {{
                            label: this._label,
                            msg_type: type,
                            data: JSON.stringify(data)
                        }}
                    }});
                }} catch(e) {{
                    console.error('[viboplr-bridge] emit error:', e);
                }}
            }} else {{
                console.warn('[viboplr-bridge] __TAURI_INTERNALS__ not available');
            }}
        }}
    }};
}})();"#,
        label.replace('\\', "\\\\").replace('\'', "\\'")
    );

    let label_for_nav = label.clone();
    let app_for_nav = app.clone();

    // Impersonate Safari so sites serve their normal web experience
    let safari_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) \
                     AppleWebKit/605.1.15 (KHTML, like Gecko) \
                     Version/17.5 Safari/605.1.15";

    let label_for_close = label.clone();
    let app_for_close = app.clone();

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(title.unwrap_or_else(|| "Viboplr Browse".to_string()))
        .inner_size(width.unwrap_or(1200.0), height.unwrap_or(800.0))
        .visible(visible.unwrap_or(true))
        // Hidden/occluded WKWebViews are suspended by default on macOS, which
        // freezes the timer-driven scrape loop (it only resumes when the window
        // is shown). Disable throttling so background scraping keeps running.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .user_agent(safari_ua)
        .initialization_script(&init_script)
        // Autoplay-gate shim runs in every frame (main-frame-only would miss
        // player iframes).
        .initialization_script_for_all_frames(autoplay_gate_script)
        .on_navigation(move |nav_url| {
            let _ = app_for_nav.emit(
                "browse-window-navigation",
                BrowseWindowNavigation {
                    label: label_for_nav.clone(),
                    url: nav_url.to_string(),
                },
            );
            true // allow all navigation
        })
        .build()
        .map_err(|e| e.to_string())?;

    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = app_for_close.emit(
                "browse-window-closed",
                BrowseWindowClosed {
                    label: label_for_close.clone(),
                },
            );
        }
    });

    Ok(())
}

/// Evaluate JavaScript in a browse window. Fire-and-forget — use
/// `window.__viboplr.send()` from the injected JS to return results.
#[tauri::command]
pub async fn browse_window_eval(
    app: tauri::AppHandle,
    label: String,
    js: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or("Browse window not found")?;
    window.eval(&js).map_err(|e| e.to_string())
}

/// Close a browse window by label. No-op if already closed.
#[tauri::command]
pub async fn close_browse_window(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show or hide a browse window by label.
#[tauri::command]
pub async fn browse_window_set_visible(
    app: tauri::AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or("Browse window not found")?;
    if visible {
        window.show().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Receive a message from browse-window injected JS and re-emit as a
/// Tauri event so the frontend plugin host can forward it to the plugin.
#[tauri::command]
pub async fn browse_window_send(
    app: tauri::AppHandle,
    label: String,
    msg_type: String,
    data: String,
) -> Result<(), String> {
    app.emit(
        "browse-window-message",
        BrowseWindowMessage {
            label,
            msg_type,
            data,
        },
    )
    .map_err(|e| e.to_string())
}
