use std::path::PathBuf;

fn main() {
    // libmpv2-sys emits only `cargo:rustc-link-lib=mpv`; the search path to the
    // vendored libmpv (fetched by scripts/fetch-libmpv.mjs) is supplied here.
    if std::env::var("CARGO_FEATURE_MPV_ENGINE").is_ok() {
        let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
        let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let platform = format!("{target_os}-{target_arch}");
        let lib_dir = manifest.join("vendor").join("libmpv").join(&platform).join("lib");

        if !lib_dir.join(if target_os == "windows" { "mpv.lib" } else { "libmpv.dylib" }).exists() {
            println!(
                "cargo:warning=mpv-engine: vendored libmpv not found at {} — run `node scripts/fetch-libmpv.mjs`",
                lib_dir.display()
            );
        }

        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        if target_os == "macos" {
            // Dev runs load the dylib straight from the vendor dir; bundled apps
            // resolve @rpath/libmpv.2.dylib from Frameworks/ instead.
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        }
        if target_os == "windows" {
            // Best-effort: put the DLL next to the dev exe so `tauri dev` runs.
            // Bundled installs get it via tauri.mpv-windows.conf.json resources.
            let dll = lib_dir.join("libmpv-2.dll");
            if dll.exists() {
                if let Ok(out_dir) = std::env::var("OUT_DIR") {
                    // OUT_DIR = target/<profile>/build/<pkg>/out → profile dir is 3 up.
                    if let Some(profile_dir) = PathBuf::from(&out_dir).ancestors().nth(3) {
                        if std::fs::copy(&dll, profile_dir.join("libmpv-2.dll")).is_err() {
                            println!("cargo:warning=mpv-engine: could not copy libmpv-2.dll next to the dev binary");
                        }
                    }
                }
            }
        }
    }

    tauri_build::build()
}
