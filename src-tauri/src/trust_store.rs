//! The operating system's certificate trust store as a PEM file, for the TLS
//! stacks that don't read it themselves:
//!
//! - **libmpv** links a static OpenSSL with no CA store (`mpv_engine`, which
//!   sets `tls-ca-file`).
//! - **yt-dlp** is Python and prefers the `certifi` list it bundles
//!   (`dependencies`, `OsTrust`).
//!
//! Why the whole store, not just Apple's roots: a network that inspects HTTPS
//! (a company proxy, some security tools) re-signs every site with its own
//! root, which the administrator installs into the Mac's trust settings —
//! usually the *admin* domain (MDM / System.keychain), sometimes the user's.
//! Safari and Chrome trust it because they read those settings; a program that
//! only knows Apple's built-in roots (what mpv used to be given) or certifi
//! (what yt-dlp uses) cannot tell that proxy from an attacker, and every
//! request fails with a certificate error.
//!
//! **Trust settings are honoured, not just the certificate list.** A plain
//! keychain dump would also export certificates the user marked "Never Trust"
//! and intermediates that aren't anchors. This walks the three trust-settings
//! domains the way macOS itself resolves them — user overrides admin overrides
//! system — and keeps only certificates whose TLS trust resolves to *trust as
//! root*; a certificate with no settings in a domain counts as a trusted root,
//! which is Apple's documented meaning of an empty settings array. The same
//! algorithm as `rustls-native-certs`, on the `security-framework` crate the
//! app already links.
//!
//! **Intermediates too.** An inspecting proxy often sends only part of the
//! chain (seen here: Zscaler sends the leaf and one intermediate, not the
//! issuing CA above it). macOS fills the gap from the keychain on its own;
//! an OpenSSL client (Python, libmpv) can only use what is in its CA file, so
//! with roots alone the chain can't be built and verification still fails.
//! The bundle therefore also carries the **CA** certificates in the keychain
//! search list (login + System) that are not self-signed, not denied, and
//! **whose chain reaches one of the trusted roots through certificates in the
//! bundle**. That last rule is what makes this widen nothing even for a
//! consumer that verifies with `X509_V_FLAG_PARTIAL_CHAIN` (Python 3.13's
//! `create_default_context` sets it, and `SSL_CERT_FILE` is inherited by
//! whatever yt-dlp starts): under partial-chain verification every certificate
//! in the file is an anchor, so an intermediate under a root macOS doesn't
//! trust must not be in it at all. Chains are followed by issuer/subject name.
//!
//! **Freshness.** Built once per app run (~0.2s), prewarmed on a background
//! thread shortly after launch (lib.rs) so no caller pays for it — mpv's
//! `engine_play` runs on the main thread. Rebuilding every run picks up a
//! certificate the administrator installs by the next launch; `invalidate()`,
//! called when yt-dlp still reports a certificate failure, forces an earlier
//! rebuild so one installed mid-session is picked up by the next attempt.
//!
//! macOS only. Windows programs get the OS store another way (yt-dlp's Python
//! reads the Windows store itself once told not to use certifi; mpv exports
//! LocalMachine\Root), and Linux programs already read the distribution bundle.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Shared across profiles, beside the managed `bin/` dir.
const FILE_NAME: &str = "trust-store.pem";

/// Error-triggered rebuilds are honoured at most this often. A site that
/// really fails verification (a blocked host, an actual attack) fails on every
/// attempt; without a cap each one would re-run the export.
const INVALIDATE_EVERY: Duration = Duration::from_secs(60);

static CACHE: Mutex<Cache> = Mutex::new(Cache::new());

/// The PEM file holding the OS's trusted TLS roots, building it if this run
/// hasn't yet. `None` when it can't be built (non-macOS, or the export found
/// nothing) — callers must then leave the program on its own trust list, which
/// can only be as good as before, never worse. A failed build is remembered for
/// the rest of the run (until `invalidate`), so a broken export costs one
/// attempt, not one per spawn.
pub fn pem_path(app_data_dir: &Path) -> Option<PathBuf> {
    let path = app_data_dir.join(FILE_NAME);
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(|| {
        let count = build(&path)?;
        log::info!("trust store: exported {count} certificates to {}", path.display());
        Ok(path.clone())
    })
}

/// Ask for a re-export on the next `pem_path` (a certificate may have been
/// installed since). Rate-limited to once per `INVALIDATE_EVERY`.
pub fn invalidate() {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).invalidate(Instant::now());
}

#[derive(Debug, PartialEq)]
enum State {
    Unbuilt,
    Built(PathBuf),
    Failed,
}

/// The per-run bundle state, with the build step and the clock passed in so the
/// caching and rate-limit rules are testable without a keychain or a wait.
struct Cache {
    state: State,
    last_invalidate: Option<Instant>,
}

impl Cache {
    const fn new() -> Self {
        Self { state: State::Unbuilt, last_invalidate: None }
    }

    fn get(&mut self, build: impl FnOnce() -> Result<PathBuf, String>) -> Option<PathBuf> {
        match &self.state {
            State::Built(path) if path.exists() => return Some(path.clone()),
            State::Failed => return None,
            _ => {}
        }
        match build() {
            Ok(path) => {
                self.state = State::Built(path.clone());
                Some(path)
            }
            Err(e) => {
                log::warn!("trust store: could not export the OS trust store ({e}); programs keep their own trust lists");
                self.state = State::Failed;
                None
            }
        }
    }

    fn invalidate(&mut self, now: Instant) {
        if self.last_invalidate.is_some_and(|t| now.duration_since(t) < INVALIDATE_EVERY) {
            return;
        }
        self.last_invalidate = Some(now);
        self.state = State::Unbuilt;
    }
}

#[cfg(target_os = "macos")]
fn build(path: &Path) -> Result<usize, String> {
    let (roots, denied) = macos::trusted_roots();
    if roots.is_empty() {
        return Err("no trusted root certificates found".into());
    }
    let intermediates = macos::keychain_intermediates(&roots, &denied);
    log::info!("trust store: {} roots + {} intermediate CAs", roots.len(), intermediates.len());
    let mut ders = roots;
    ders.extend(intermediates);
    write_pem(path, &ders)?;
    Ok(ders.len())
}

#[cfg(not(target_os = "macos"))]
fn build(_path: &Path) -> Result<usize, String> {
    Err("only needed on macOS".into())
}

/// PEM-encode certificates and write them atomically, so a program starting
/// mid-write never reads half a bundle.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn write_pem(path: &Path, ders: &[Vec<u8>]) -> Result<(), String> {
    let pem = to_pem(ders);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("pem.tmp-{}", std::process::id()));
    std::fs::write(&tmp, pem).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replacing {}: {e}", path.display())
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn to_pem(ders: &[Vec<u8>]) -> String {
    use base64::Engine;
    let mut out = String::new();
    for der in ders {
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        out.push_str("-----BEGIN CERTIFICATE-----\n");
        for chunk in b64.as_bytes().chunks(64) {
            out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
            out.push('\n');
        }
        out.push_str("-----END CERTIFICATE-----\n");
    }
    out
}

#[cfg(target_os = "macos")]
mod macos {
    use security_framework::trust_settings::{Domain, TrustSettings, TrustSettingsForCertificate};
    use std::collections::{HashMap, HashSet};

    /// DER of every certificate macOS trusts as a TLS root, resolved across the
    /// user → admin → system trust-settings domains (first domain to speak
    /// wins) — plus the set the trust settings explicitly deny, which the
    /// intermediate pass must never add back.
    pub fn trusted_roots() -> (Vec<Vec<u8>>, HashSet<Vec<u8>>) {
        let mut verdicts: HashMap<Vec<u8>, TrustSettingsForCertificate> = HashMap::new();
        for domain in [Domain::User, Domain::Admin, Domain::System] {
            let settings = TrustSettings::new(domain);
            let iter = match settings.iter() {
                Ok(iter) => iter,
                Err(e) => {
                    // A domain with no trust settings at all (commonly User) is
                    // an error here, not an empty list — not worth a warning.
                    log::debug!("trust store: no {domain:?} trust settings: {e}");
                    continue;
                }
            };
            for cert in iter {
                let verdict = match settings.tls_trust_settings_for_certificate(&cert) {
                    // Apple: an empty settings array means "always trust as root".
                    Ok(v) => v.unwrap_or(TrustSettingsForCertificate::TrustRoot),
                    Err(e) => {
                        log::debug!("trust store: skipping a certificate with unreadable trust settings: {e}");
                        continue;
                    }
                };
                verdicts.entry(cert.to_der()).or_insert(verdict);
            }
        }
        let denied: HashSet<Vec<u8>> = verdicts
            .iter()
            .filter(|(_, v)| matches!(v, TrustSettingsForCertificate::Deny))
            .map(|(der, _)| der.clone())
            .collect();
        let mut roots: Vec<Vec<u8>> = verdicts
            .into_iter()
            .filter(|(_, v)| matches!(v, TrustSettingsForCertificate::TrustRoot | TrustSettingsForCertificate::TrustAsRoot))
            .map(|(der, _)| der)
            .collect();
        roots.sort(); // stable file content run to run
        (roots, denied)
    }

    /// CA certificates from the keychain search list (login + System) that a
    /// chain may need between a site and a trusted root: CA per Basic
    /// Constraints, not self-signed (a root only counts if the trust settings
    /// above say so), not denied, not already a root.
    pub fn keychain_intermediates(roots: &[Vec<u8>], denied: &HashSet<Vec<u8>>) -> Vec<Vec<u8>> {
        // `security` enumerates the user's keychain search list; the keychain
        // item API would need a second, much larger surface for the same list.
        let out = match std::process::Command::new("/usr/bin/security").args(["find-certificate", "-a", "-p"]).output() {
            Ok(out) if out.status.success() => out.stdout,
            Ok(out) => {
                log::warn!("trust store: listing keychain certificates failed (exit {})", out.status);
                return Vec::new();
            }
            Err(e) => {
                log::warn!("trust store: listing keychain certificates failed: {e}");
                return Vec::new();
            }
        };
        let known: HashSet<&[u8]> = roots.iter().map(|d| d.as_slice()).collect();
        let mut seen = HashSet::new();
        let candidates: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = super::pem_blocks(&String::from_utf8_lossy(&out))
            .into_iter()
            .filter(|der| super::is_ca(der) && !super::is_self_issued(der))
            .filter(|der| !known.contains(der.as_slice()) && !denied.contains(der))
            .filter(|der| seen.insert(der.clone()))
            .filter_map(|der| {
                let (issuer, subject) = super::names(&der)?;
                Some((der, issuer, subject))
            })
            .collect();
        let root_subjects: HashSet<Vec<u8>> = roots.iter().filter_map(|d| super::names(d).map(|(_, s)| s)).collect();
        let mut chained = super::chained_to(&root_subjects, candidates);
        chained.sort();
        chained
    }
}

/// Decode every `CERTIFICATE` block in a PEM text to DER.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pem_blocks(text: &str) -> Vec<Vec<u8>> {
    use base64::Engine;
    let mut out = Vec::new();
    let mut body: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line == "-----BEGIN CERTIFICATE-----" {
            body = Some(String::new());
        } else if line == "-----END CERTIFICATE-----" {
            if let Some(b64) = body.take() {
                if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(b64) {
                    out.push(der);
                }
            }
        } else if let Some(b) = body.as_mut() {
            b.push_str(line);
        }
    }
    out
}

/// Basic Constraints says `cA: TRUE`. Matched on the DER encoding directly —
/// OID 2.5.29.19, then (after an optional `critical`) the extension value's
/// `SEQUENCE { BOOLEAN TRUE …`; DER encodes TRUE only as `FF`. No parser
/// dependency for one bit.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_ca(der: &[u8]) -> bool {
    const OID: [u8; 5] = [0x06, 0x03, 0x55, 0x1D, 0x13];
    let Some(at) = der.windows(OID.len()).position(|w| w == OID) else {
        return false;
    };
    let mut i = at + OID.len();
    // optional `critical BOOLEAN TRUE`
    if der.get(i..i + 3) == Some(&[0x01, 0x01, 0xFF]) {
        i += 3;
    }
    // OCTET STRING { SEQUENCE { BOOLEAN TRUE
    matches!((der.get(i), der.get(i + 2), der.get(i + 4..i + 7)),
        (Some(0x04), Some(0x30), Some(&[0x01, 0x01, 0xFF])))
}

/// The candidates whose issuer is a trusted root's subject, or — transitively —
/// the subject of another candidate that qualifies. Anything left over hangs
/// off a root the OS doesn't trust (or off nothing) and is dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn chained_to(
    root_subjects: &std::collections::HashSet<Vec<u8>>,
    mut candidates: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)>,
) -> Vec<Vec<u8>> {
    let mut reachable = root_subjects.clone();
    let mut out = Vec::new();
    loop {
        let before = out.len();
        candidates.retain(|(der, issuer, subject)| {
            if reachable.contains(issuer) {
                reachable.insert(subject.clone());
                out.push(der.clone());
                false
            } else {
                true
            }
        });
        if out.len() == before {
            return out;
        }
    }
}

/// Issuer name equals subject name (a self-signed root).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_self_issued(der: &[u8]) -> bool {
    // Unparseable: treat as a root, i.e. never add it as an intermediate.
    names(der).map_or(true, |(issuer, subject)| issuer == subject)
}

/// The raw DER `Name` encodings of (issuer, subject) — the 4th and 6th fields
/// of TBSCertificate, after an optional explicit `[0] version`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn names(der: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    fn tlv(buf: &[u8], at: usize) -> Option<(usize, usize)> {
        // Returns (start of this TLV, end of this TLV).
        let len0 = *buf.get(at + 1)? as usize;
        let (len, hdr) = if len0 < 0x80 {
            (len0, 2)
        } else {
            let n = len0 & 0x7F;
            if n == 0 || n > 4 {
                return None;
            }
            let mut l = 0usize;
            for k in 0..n {
                l = (l << 8) | *buf.get(at + 2 + k)? as usize;
            }
            (l, 2 + n)
        };
        Some((at, at + hdr + len))
    }
    fn inner(buf: &[u8], at: usize) -> Option<usize> {
        let len0 = *buf.get(at + 1)? as usize;
        Some(at + if len0 < 0x80 { 2 } else { 2 + (len0 & 0x7F) })
    }
    (|| {
        let tbs = inner(der, 0)?; // Certificate SEQUENCE → TBSCertificate
        let mut at = inner(der, tbs)?; // TBSCertificate SEQUENCE → first field
        if *der.get(at)? == 0xA0 {
            at = tlv(der, at)?.1; // [0] version
        }
        at = tlv(der, at)?.1; // serialNumber
        at = tlv(der, at)?.1; // signature AlgorithmIdentifier
        let issuer = tlv(der, at)?;
        let validity = tlv(der, issuer.1)?;
        let subject = tlv(der, validity.1)?;
        Some((der.get(issuer.0..issuer.1)?.to_vec(), der.get(subject.0..subject.1)?.to_vec()))
    })()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_encoding_wraps_at_64_and_round_trips() {
        let der: Vec<u8> = (0..200u8).collect();
        let pem = to_pem(&[der.clone()]);
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(pem.ends_with("-----END CERTIFICATE-----\n"));
        let body: Vec<&str> = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        assert!(body.iter().all(|l| l.len() <= 64));
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(body.concat()).unwrap();
        assert_eq!(decoded, der);
    }

    /// Real certificates from this Mac, classified by the DER checks: every
    /// root the trust settings name is self-issued, and the intermediates
    /// pass is CA-only and never re-adds a root.
    #[cfg(target_os = "macos")]
    #[test]
    fn classifies_real_keychain_certificates() {
        let (roots, denied) = macos::trusted_roots();
        let self_issued = roots.iter().filter(|d| is_self_issued(d)).count();
        assert!(self_issued * 10 >= roots.len() * 9, "{self_issued}/{} roots read as self-issued", roots.len());
        let intermediates = macos::keychain_intermediates(&roots, &denied);
        let mut subjects: std::collections::HashSet<Vec<u8>> =
            roots.iter().filter_map(|d| names(d).map(|(_, s)| s)).collect();
        subjects.extend(intermediates.iter().filter_map(|d| names(d).map(|(_, s)| s)));
        for der in &intermediates {
            assert!(is_ca(der) && !is_self_issued(der));
            assert!(!roots.contains(der) && !denied.contains(der));
            let (issuer, _) = names(der).unwrap();
            assert!(subjects.contains(&issuer), "every intermediate chains to something in the bundle");
        }
    }

    #[test]
    fn a_failed_build_is_not_retried_until_invalidated() {
        let mut cache = Cache::new();
        let mut calls = 0;
        assert_eq!(cache.get(|| { calls += 1; Err("boom".into()) }), None);
        assert_eq!(cache.get(|| { calls += 1; Err("boom".into()) }), None);
        assert_eq!(calls, 1, "a failed export must be remembered, not re-run per spawn");
        cache.invalidate(Instant::now());
        assert_eq!(cache.get(|| { calls += 1; Err("boom".into()) }), None);
        assert_eq!(calls, 2);
    }

    #[test]
    fn a_built_bundle_is_reused_while_its_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "x").unwrap();
        let mut cache = Cache::new();
        let mut calls = 0;
        assert_eq!(cache.get(|| { calls += 1; Ok(path.clone()) }), Some(path.clone()));
        assert_eq!(cache.get(|| { calls += 1; Ok(path.clone()) }), Some(path.clone()));
        assert_eq!(calls, 1);
        std::fs::remove_file(&path).unwrap();
        cache.get(|| { calls += 1; Ok(path.clone()) });
        assert_eq!(calls, 2, "a deleted bundle is rebuilt");
    }

    #[test]
    fn invalidation_is_rate_limited() {
        let mut cache = Cache::new();
        let t0 = Instant::now();
        cache.state = State::Failed;
        cache.invalidate(t0);
        assert_eq!(cache.state, State::Unbuilt);
        cache.state = State::Failed;
        cache.invalidate(t0 + Duration::from_secs(10));
        assert_eq!(cache.state, State::Failed, "a second invalidation within the window is ignored");
        cache.invalidate(t0 + INVALIDATE_EVERY + Duration::from_secs(1));
        assert_eq!(cache.state, State::Unbuilt);
    }

    #[test]
    fn only_intermediates_that_reach_a_trusted_root_are_kept() {
        let v = |s: &str| s.as_bytes().to_vec();
        let roots: std::collections::HashSet<Vec<u8>> = [v("Root")].into_iter().collect();
        let candidates = vec![
            // listed before its issuer on purpose: order must not matter
            (v("der-leafca"), v("Issuing CA"), v("Leaf CA")),
            (v("der-issuing"), v("Root"), v("Issuing CA")),
            (v("der-orphan"), v("Untrusted Root"), v("Orphan CA")),
            (v("der-orphan-child"), v("Orphan CA"), v("Orphan Child")),
        ];
        let mut kept = chained_to(&roots, candidates);
        kept.sort();
        assert_eq!(kept, vec![v("der-issuing"), v("der-leafca")]);
    }

    #[test]
    fn pem_blocks_round_trip() {
        let ders = vec![vec![1u8, 2, 3], (0..150u8).collect::<Vec<u8>>()];
        assert_eq!(pem_blocks(&to_pem(&ders)), ders);
    }

    /// Real export against this Mac's trust settings: it must find Apple's
    /// roots at minimum, and write a file OpenSSL-style consumers can read.
    #[cfg(target_os = "macos")]
    #[test]
    fn exports_the_macos_trust_store() {
        let (roots, _) = macos::trusted_roots();
        assert!(roots.len() > 50, "expected Apple's built-in roots at least, got {}", roots.len());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write_pem(&path, &roots).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("BEGIN CERTIFICATE").count(), roots.len());
    }
}
