//! Unpack a downloaded release (`.zip`, `.tar.gz` / `.tgz`) inside a plugin's
//! store.
//!
//! The archive is untrusted, so every entry is held to three rules: its path
//! stays under the destination (no absolute paths, no `..`), it is a plain file
//! or folder (symlinks and hard links are skipped, so nothing can point out of
//! the store afterwards), and the archive as a whole stays under
//! `MAX_ENTRIES` / `MAX_TOTAL_BYTES` (a zip bomb fails rather than filling the
//! disk). Unix permission bits are kept where the archive has them, which is
//! what lets an unpacked binary run.
//!
//! It unpacks into a sibling `…partial-<pid>` folder and renames it into place
//! only when every entry made it, replacing what was there — so a failed or
//! interrupted unpack never leaves a half-written version where the plugin
//! expects a whole one.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_ENTRIES: usize = 50_000;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    TarGz,
}

impl Kind {
    pub fn of(path: &Path) -> Option<Kind> {
        let name = path.file_name()?.to_str()?.to_ascii_lowercase();
        if name.ends_with(".zip") {
            Some(Kind::Zip)
        } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            Some(Kind::TarGz)
        } else {
            None
        }
    }
}

/// An entry's path, relative and free of `..` / roots / prefixes, or `None`.
fn safe_relative(raw: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

struct Budget {
    entries: usize,
    bytes: u64,
}

impl Budget {
    fn entry(&mut self) -> Result<(), String> {
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            return Err(format!("The archive has more than {MAX_ENTRIES} entries"));
        }
        Ok(())
    }
}

/// Forwards to `inner` and hashes what passes through, so an unpacked file's
/// sha256 costs no second read.
struct HashingWriter<W> {
    inner: W,
    hasher: sha2::Sha256,
}

impl<W: std::io::Write> std::io::Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        use sha2::Digest;
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Every file an unpack wrote: its path under the destination and its sha256.
pub type Unpacked = Vec<(PathBuf, String)>;

fn write_file(dest: &Path, rel: &Path, reader: &mut dyn Read, mode: Option<u32>, budget: &mut Budget) -> Result<String, String> {
    let target = dest.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let file = std::fs::File::create(&target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
    let mut out = HashingWriter { inner: file, hasher: <sha2::Sha256 as sha2::Digest>::new() };
    let room = MAX_TOTAL_BYTES.saturating_sub(budget.bytes);
    let written = std::io::copy(&mut reader.take(room + 1), &mut out)
        .map_err(|e| format!("Couldn't unpack {}: {e}", rel.display()))?;
    budget.bytes += written;
    if budget.bytes > MAX_TOTAL_BYTES {
        return Err(format!("The archive unpacks to more than {} GB", MAX_TOTAL_BYTES / (1024 * 1024 * 1024)));
    }
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        // Owner always keeps read/write; setuid/setgid/sticky are never applied.
        let mode = (mode & 0o777) | 0o600;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = mode;
    let digest = sha2::Digest::finalize(out.hasher);
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

fn unpack_zip(archive: &Path, dest: &Path) -> Result<Unpacked, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Not a readable zip: {e}"))?;
    let mut budget = Budget { entries: 0, bytes: 0 };
    let mut files = Unpacked::new();
    for i in 0..zip.len() {
        budget.entry()?;
        let mut entry = zip.by_index(i).map_err(|e| format!("Bad zip entry: {e}"))?;
        let Some(rel) = entry.enclosed_name().and_then(|p| safe_relative(&p)) else {
            log::warn!("unpack: skipped unsafe zip entry {:?}", entry.name());
            continue;
        };
        if entry.is_symlink() {
            log::warn!("unpack: skipped symlink {}", rel.display());
            continue;
        }
        if entry.is_dir() {
            std::fs::create_dir_all(dest.join(&rel)).map_err(|e| format!("Couldn't create {}: {e}", rel.display()))?;
            continue;
        }
        let mode = entry.unix_mode();
        let sha = write_file(dest, &rel, &mut entry, mode, &mut budget)?;
        files.push((rel, sha));
    }
    Ok(files)
}

fn unpack_tar_gz(archive: &Path, dest: &Path) -> Result<Unpacked, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("Couldn't open {}: {e}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut budget = Budget { entries: 0, bytes: 0 };
    let mut files = Unpacked::new();
    for entry in tar.entries().map_err(|e| format!("Not a readable tar.gz: {e}"))? {
        budget.entry()?;
        let mut entry = entry.map_err(|e| format!("Bad tar entry: {e}"))?;
        let raw = entry.path().map_err(|e| format!("Bad tar entry path: {e}"))?.into_owned();
        let Some(rel) = safe_relative(&raw) else {
            log::warn!("unpack: skipped unsafe tar entry {}", raw.display());
            continue;
        };
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            std::fs::create_dir_all(dest.join(&rel)).map_err(|e| format!("Couldn't create {}: {e}", rel.display()))?;
        } else if kind.is_file() {
            let mode = entry.header().mode().ok();
            let sha = write_file(dest, &rel, &mut entry, mode, &mut budget)?;
            files.push((rel, sha));
        } else {
            log::warn!("unpack: skipped non-file tar entry {}", rel.display());
        }
    }
    Ok(files)
}

/// Unpack `archive` to `dest`, replacing `dest` if it exists. Returns every
/// file written with its sha256 (what `approved::record_unpacked` takes). Both
/// paths are already confined by the caller.
pub fn extract(archive: &Path, dest: &Path) -> Result<Unpacked, String> {
    let kind = Kind::of(archive).ok_or_else(|| format!("{} is not a .zip or .tar.gz", archive.display()))?;
    let parent = dest.parent().ok_or("Invalid destination")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    let leaf = dest.file_name().and_then(|n| n.to_str()).ok_or("Invalid destination")?;
    let partial = parent.join(format!(".{leaf}.partial-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial).map_err(|e| format!("Couldn't create {}: {e}", partial.display()))?;
    let result = match kind {
        Kind::Zip => unpack_zip(archive, &partial),
        Kind::TarGz => unpack_tar_gz(archive, &partial),
    };
    let files = match result {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&partial);
            return Err(e);
        }
    };
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| {
            let _ = std::fs::remove_dir_all(&partial);
            format!("Couldn't replace {}: {e}", dest.display())
        })?;
    }
    std::fs::rename(&partial, dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&partial);
        format!("Couldn't move the unpacked files into place: {e}")
    })?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(entries: &[(&str, &[u8], Option<u32>)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            for (name, body, mode) in entries {
                let mut opts = zip::write::SimpleFileOptions::default();
                if let Some(m) = mode {
                    opts = opts.unix_permissions(*m);
                }
                zip.start_file(*name, opts).unwrap();
                zip.write_all(body).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn test_unpacks_a_zip_and_keeps_the_exec_bit() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("rel.zip");
        std::fs::write(&archive, zip_with(&[("slskd", b"bin", Some(0o755)), ("wwwroot/index.html", b"<html>", None)])).unwrap();
        let dest = dir.path().join("versions").join("0.26.1");
        assert_eq!(extract(&archive, &dest).unwrap().len(), 2);
        assert_eq!(std::fs::read(dest.join("wwwroot/index.html")).unwrap(), b"<html>");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dest.join("slskd")).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn test_entries_that_escape_are_skipped_and_a_rerun_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("evil.zip");
        std::fs::write(&archive, zip_with(&[("../outside.txt", b"x", None), ("ok.txt", b"1", None)])).unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("stale.txt"), "old").unwrap();
        assert_eq!(extract(&archive, &dest).unwrap().len(), 1);
        assert!(!dir.path().join("outside.txt").exists());
        assert!(dest.join("ok.txt").exists());
        assert!(!dest.join("stale.txt").exists(), "the destination is replaced, not merged");
    }

    #[test]
    fn test_unpacks_a_tar_gz() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("rel.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(std::fs::File::create(&archive).unwrap(), flate2::Compression::fast());
            let mut tar = tar::Builder::new(gz);
            let body = b"#!/bin/sh\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, "bin/tool", &body[..]).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        let dest = dir.path().join("t");
        let unpacked = extract(&archive, &dest).unwrap();
        assert_eq!(unpacked.len(), 1);
        assert_eq!(unpacked[0].0, PathBuf::from("bin/tool"));
        assert_eq!(unpacked[0].1, crate::plugin_programs::approved::hash_file(&dest.join("bin/tool")).unwrap());
        assert!(dest.join("bin/tool").is_file());
    }

    #[test]
    fn test_a_broken_archive_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("broken.zip");
        std::fs::write(&archive, b"not a zip").unwrap();
        let dest = dir.path().join("x");
        assert!(extract(&archive, &dest).is_err());
        assert!(!dest.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no partial folder left");
        assert!(extract(&dir.path().join("a.rar"), &dest).is_err());
    }
}
