fn main() {
    // libmpv is no longer linked at build time — the engine loads it at
    // runtime (src/mpv_engine/ffi.rs), so no link-search path or rpaths are
    // emitted here. Dev/test builds resolve the vendored copy fetched by
    // `node scripts/fetch-libmpv.mjs` directly by path.
    tauri_build::build()
}
