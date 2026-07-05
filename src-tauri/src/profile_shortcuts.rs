// Per-profile desktop launchers: .lnk (Windows), wrapper .app bundle (macOS),
// .desktop file (Linux). Content generation is split into pure string builders
// so it can be unit-tested on any platform; only the filesystem writer is
// cfg-gated. Profile names are already constrained (alphanumeric/hyphen/
// underscore, Unicode letters allowed) so they need no XML/Exec escaping —
// paths, which the user controls, do.

use std::path::{Path, PathBuf};

pub fn shortcut_display_name(profile: &str) -> String {
    format!("Viboplr – {}", profile)
}

/// CFBundleIdentifier components must stay ASCII alphanumeric/hyphen; profile
/// names may be Unicode. Lossy-sanitize (drop non-ASCII, `_` → `-`) with a
/// fixed fallback — uniqueness of the wrapper id is cosmetic, distinctness
/// from the main app id is what matters to Launch Services.
pub fn sanitize_bundle_id_component(name: &str) -> String {
    let s: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                Some(c.to_ascii_lowercase())
            } else if c == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect();
    if s.is_empty() { "profile".to_string() } else { s }
}

/// Launcher script for the macOS wrapper bundle. `open -nb`: resolve the main
/// app by bundle id (rename-proof, unlike `-a` by name); `-n` forces a fresh
/// process — without it Launch Services activates the running instance and
/// drops `--args`, so the single-instance handoff would never fire.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // macos arm + tests
pub fn macos_launcher_script(app_identifier: &str, profile: &str) -> String {
    format!(
        "#!/bin/sh\nexec open -nb \"{}\" --args --profile \"{}\"\n",
        app_identifier, profile
    )
}

/// Info.plist for the wrapper bundle. Distinct CFBundleIdentifier per profile
/// (a wrapper claiming the main app's id confuses Launch Services);
/// LSUIElement keeps the short-lived wrapper out of the Dock. The profile-name
/// charset cannot contain XML metacharacters, so no escaping is needed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // macos arm + tests
pub fn macos_info_plist(app_identifier: &str, profile: &str, icon_file: Option<&str>) -> String {
    let display = shortcut_display_name(profile);
    let icon = icon_file
        .map(|f| format!("    <key>CFBundleIconFile</key><string>{}</string>\n", f))
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>{display}</string>
    <key>CFBundleDisplayName</key><string>{display}</string>
    <key>CFBundleIdentifier</key><string>{app_identifier}.profile.{component}</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>launcher</string>
{icon}    <key>LSUIElement</key><true/>
</dict>
</plist>
"#,
        display = display,
        app_identifier = app_identifier,
        component = sanitize_bundle_id_component(profile),
        icon = icon,
    )
}

/// Single-quote a string for /bin/sh (embedded quotes become '\'' ).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // macos dev arm + tests
pub fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Quote an Exec executable path per the freedesktop Desktop Entry spec:
/// wrap in double quotes, escape the reserved characters, and double literal
/// `%` (Exec field-code escape — `%2` in a URL-encoded AppImage name would
/// otherwise be stripped as an unknown field code). An unquoted path with
/// spaces (e.g. an AppImage under "~/My Apps/") silently breaks parsing.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // linux arm + tests
pub fn quote_exec_path(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len() + 2);
    for c in path.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                escaped.push('\\');
                escaped.push(c);
            }
            '%' => escaped.push_str("%%"),
            _ => escaped.push(c),
        }
    }
    format!("\"{}\"", escaped)
}

/// Freedesktop .desktop entry. The profile name needs no quoting (its charset
/// excludes spaces and shell metacharacters); the exec path does.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // linux arm + tests
pub fn linux_desktop_entry(exec_path: &str, profile: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nComment=Viboplr profile {profile}\nExec={exec} --profile {profile}\nIcon=viboplr\nTerminal=false\nCategories=AudioVideo;Audio;Player;\n",
        name = shortcut_display_name(profile),
        profile = profile,
        exec = quote_exec_path(exec_path),
    )
}

/// Write the platform shortcut onto `desktop`, silently overwriting an
/// existing one (idempotent "Create shortcut"). Returns the written path.
/// `appimage` is the $APPIMAGE path on Linux AppImage installs — the mount-
/// point binary dies with the process, so Exec must point at the AppImage.
#[allow(unused_variables)] // each platform arm uses a different subset of params
pub fn create_shortcut_on(
    desktop: &Path,
    profile: &str,
    app_identifier: &str,
    bin: &Path,
    appimage: Option<&Path>,
) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = desktop.join(format!("{}.app", shortcut_display_name(profile)));
        let macos_dir = bundle.join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos_dir).map_err(|e| e.to_string())?;

        // Best-effort icon: copy the running bundle's first .icns (absent in
        // dev builds where the binary isn't inside a bundle).
        let mut icon_file = None;
        if let Some(resources) = bin.parent().and_then(|p| p.parent()).map(|c| c.join("Resources")) {
            if let Ok(entries) = std::fs::read_dir(&resources) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().is_some_and(|e| e == "icns") {
                        let res_dir = bundle.join("Contents").join("Resources");
                        std::fs::create_dir_all(&res_dir).map_err(|e| e.to_string())?;
                        std::fs::copy(&path, res_dir.join("app.icns")).map_err(|e| e.to_string())?;
                        icon_file = Some("app.icns");
                        break;
                    }
                }
            }
        }

        std::fs::write(
            bundle.join("Contents").join("Info.plist"),
            macos_info_plist(app_identifier, profile, icon_file),
        )
        .map_err(|e| e.to_string())?;

        let launcher = macos_dir.join("launcher");
        // Dev builds aren't a Launch-Services-registered bundle — `open -nb`
        // would resolve an installed release copy (or nothing) while the
        // create path reports success. Exec the running binary directly; it
        // still routes through single-instance.
        let script = if cfg!(debug_assertions) {
            format!(
                "#!/bin/sh\nexec {} --profile \"{}\"\n",
                sh_single_quote(&bin.to_string_lossy()),
                profile
            )
        } else {
            macos_launcher_script(app_identifier, profile)
        };
        std::fs::write(&launcher, script).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        Ok(bundle)
    }

    #[cfg(target_os = "windows")]
    {
        let lnk_path = desktop.join(format!("{}.lnk", shortcut_display_name(profile)));
        let mut link = mslnk::ShellLink::new(bin).map_err(|e| e.to_string())?;
        link.set_arguments(Some(format!("--profile {}", profile)));
        link.set_name(Some(shortcut_display_name(profile)));
        link.set_icon_location(Some(bin.to_string_lossy().to_string()));
        if lnk_path.exists() {
            std::fs::remove_file(&lnk_path).map_err(|e| e.to_string())?;
        }
        link.create_lnk(&lnk_path).map_err(|e| e.to_string())?;
        Ok(lnk_path)
    }

    #[cfg(target_os = "linux")]
    {
        let exec_path = appimage.unwrap_or(bin);
        let file = desktop.join(format!("viboplr-{}.desktop", profile));
        std::fs::write(&file, linux_desktop_entry(&exec_path.to_string_lossy(), profile))
            .map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_bundle_id_component() {
        assert_eq!(sanitize_bundle_id_component("Work"), "work");
        assert_eq!(sanitize_bundle_id_component("kids_2"), "kids-2");
        // Unicode letters are valid profile-name chars but not bundle-id chars.
        assert_eq!(sanitize_bundle_id_component("Ελλάδα"), "profile");
    }

    #[test]
    fn test_macos_launcher_script_uses_bundle_id_and_new_instance() {
        let s = macos_launcher_script("com.alex.viboplr", "work");
        assert_eq!(
            s,
            "#!/bin/sh\nexec open -nb \"com.alex.viboplr\" --args --profile \"work\"\n"
        );
    }

    #[test]
    fn test_macos_info_plist_distinct_identifier_and_icon() {
        let p = macos_info_plist("com.alex.viboplr", "Work", Some("app.icns"));
        assert!(p.contains("<string>com.alex.viboplr.profile.work</string>"));
        assert!(p.contains("<string>Viboplr – Work</string>"));
        assert!(p.contains("CFBundleIconFile"));
        let no_icon = macos_info_plist("com.alex.viboplr", "Work", None);
        assert!(!no_icon.contains("CFBundleIconFile"));
    }

    #[test]
    fn test_linux_desktop_entry_quotes_spaced_exec_path() {
        let e = linux_desktop_entry("/home/u/My Apps/viboplr.AppImage", "work");
        assert!(e.contains("Exec=\"/home/u/My Apps/viboplr.AppImage\" --profile work\n"));
        assert!(e.contains("Terminal=false"));
        assert!(e.contains("Name=Viboplr – work"));
    }

    #[test]
    fn test_sh_single_quote() {
        assert_eq!(sh_single_quote("/plain/path"), "'/plain/path'");
        assert_eq!(sh_single_quote("/o'brien/app"), r"'/o'\''brien/app'");
    }

    #[test]
    fn test_quote_exec_path_escapes_reserved_chars() {
        assert_eq!(quote_exec_path(r#"/a/b"c"#), r#""/a/b\"c""#);
        assert_eq!(quote_exec_path("/a/$b"), "\"/a/\\$b\"");
        assert_eq!(quote_exec_path("/plain/path"), "\"/plain/path\"");
        // Literal % must double per the Exec field-code rules.
        assert_eq!(quote_exec_path("/apps/Viboplr%201.AppImage"), "\"/apps/Viboplr%%201.AppImage\"");
    }
}
