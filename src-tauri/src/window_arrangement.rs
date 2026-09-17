//! Per-display-arrangement window geometry: the monitor-set signature.
//!
//! The frontend keys saved window geometry by a signature of the connected
//! monitors (`src/utils/windowArrangement.ts`), so each desk setup —
//! laptop-only, docked — remembers its own position instead of one setup's
//! evacuation move clobbering the other's. The startup restore in `lib.rs`
//! runs before the webview exists, so it computes the same signature here.
//!
//! The two implementations MUST produce identical strings: physical position
//! and size plus scale factor ×100 rounded to an integer (no float
//! formatting), entries sorted, joined with `|`. The shared fixture is pinned
//! on both sides (`test_signature_matches_the_frontend_fixture` here,
//! `windowArrangement.test.ts` there) — change them together or not at all.

/// One monitor as the signature needs it: physical x, y, width, height, and
/// the scale factor.
pub struct MonitorEntry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

pub fn arrangement_signature(monitors: &[MonitorEntry]) -> String {
    let mut entries: Vec<(i32, i32, u32, u32, i64)> = monitors
        .iter()
        .map(|m| (m.x, m.y, m.width, m.height, (m.scale_factor * 100.0).round() as i64))
        .collect();
    entries.sort();
    entries
        .iter()
        .map(|(x, y, w, h, s)| format!("{},{},{},{},{}", x, y, w, h, s))
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin() -> MonitorEntry {
        MonitorEntry { x: 0, y: 0, width: 2560, height: 1440, scale_factor: 2.0 }
    }

    fn external() -> MonitorEntry {
        MonitorEntry { x: -1920, y: -200, width: 1920, height: 1080, scale_factor: 1.0 }
    }

    #[test]
    fn test_signature_matches_the_frontend_fixture() {
        // Pinned against windowArrangement.test.ts — the same fixture must
        // yield the same string on both sides.
        assert_eq!(arrangement_signature(&[builtin()]), "0,0,2560,1440,200");
        assert_eq!(
            arrangement_signature(&[builtin(), external()]),
            "-1920,-200,1920,1080,100|0,0,2560,1440,200",
        );
    }

    #[test]
    fn test_signature_is_order_independent() {
        assert_eq!(
            arrangement_signature(&[external(), builtin()]),
            arrangement_signature(&[builtin(), external()]),
        );
    }

    #[test]
    fn test_fractional_scale_rounds_to_a_stable_integer() {
        let m = MonitorEntry { scale_factor: 1.7500000001, ..builtin() };
        assert_eq!(arrangement_signature(&[m]), "0,0,2560,1440,175");
    }

    #[test]
    fn test_no_monitors_is_the_empty_signature() {
        assert_eq!(arrangement_signature(&[]), "");
    }
}
