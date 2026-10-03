fn main() {
    // The Aptabase telemetry key is baked in from APTABASE_APP_KEY at compile
    // time via `option_env!` (see src/telemetry.rs). cargo does NOT fingerprint
    // env vars read by env!/option_env! in source, so changing the key would not
    // trigger a rebuild. Re-export it through `rustc-env` (which IS fingerprinted)
    // and mark the ambient var as a rerun trigger, so any change — set, unset, or
    // edited — forces a recompile and re-bakes the correct value.
    println!("cargo:rerun-if-env-changed=APTABASE_APP_KEY");
    if let Ok(key) = std::env::var("APTABASE_APP_KEY") {
        println!("cargo:rustc-env=APTABASE_APP_KEY={key}");
    }

    // The ids of the plugins this build bundles (src-tauri/plugins/<id>/), baked
    // in so the app can tell its own bundled plugins from LEFTOVERS in its
    // resources folder. The Windows installer overwrites the files it ships but
    // never deletes ones a later version stopped shipping, so a plugin that was
    // once bundled and then moved to its own repo (genius, auto-tagger) stays on
    // disk forever — and was then loaded as a "built-in": stuck at its old
    // version, no Uninstall, never updated. See commands::scan_plugins_dir.
    println!("cargo:rerun-if-changed=plugins");
    let mut bundled: Vec<String> = std::fs::read_dir("plugins")
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().join("manifest.json").is_file())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    bundled.sort();
    println!("cargo:rustc-env=VIBOPLR_BUNDLED_PLUGINS={}", bundled.join(","));

    // libmpv is no longer linked at build time — the engine loads it at
    // runtime (src/mpv_engine/ffi.rs), so no link-search path or rpaths are
    // emitted here. Dev/test builds resolve the vendored copy fetched by
    // `node scripts/fetch-libmpv.mjs` directly by path.
    tauri_build::build();

    // Tauri links the Common Controls v6 manifest resource into application
    // binaries. The lib-test crate requests this library itself (lib.rs), so
    // expose the generated resource directory to rustc without duplicating the
    // binary link argument that Tauri already emits.
    #[cfg(windows)]
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        println!("cargo:rustc-link-search=native={out_dir}");
    }
}
