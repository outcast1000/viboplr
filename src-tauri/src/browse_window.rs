use serde::Serialize;
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

    let init_script = format!(
        r#"(function() {{
    window.__viboplr = {{
        _label: '{}',
        send: function(type, data) {{
            if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {{
                try {{
                    window.__TAURI_INTERNALS__.invoke('browse_window_send', {{
                        label: this._label,
                        msgType: type,
                        data: JSON.stringify(data)
                    }});
                }} catch(e) {{
                    console.error('[viboplr-bridge] invoke error:', e);
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

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title(title.unwrap_or_else(|| "Viboplr Browse".to_string()))
        .inner_size(width.unwrap_or(1200.0), height.unwrap_or(800.0))
        .visible(visible.unwrap_or(true))
        .user_agent(safari_ua)
        .initialization_script(&init_script)
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
