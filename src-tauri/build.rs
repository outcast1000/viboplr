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

    // libmpv is no longer linked at build time — the engine loads it at
    // runtime (src/mpv_engine/ffi.rs), so no link-search path or rpaths are
    // emitted here. Dev/test builds resolve the vendored copy fetched by
    // `node scripts/fetch-libmpv.mjs` directly by path.
    tauri_build::build()
}
