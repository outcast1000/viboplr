//! Bit-perfect output: device pinning and verification.
//!
//! Bit-perfect mode pins the output to one device (by CoreAudio UID) and then
//! *verifies* the path rather than trusting mpv's report. A live spike showed
//! why each part is needed:
//!
//! - `audio-device=auto` drifts: macOS moves the system default away from a
//!   hogged device, so the next AO open follows the default elsewhere.
//! - When another process holds the pinned device, mpv only warns
//!   (`failed to set hogmode`), still reports `current-ao=coreaudio_exclusive`,
//!   and then plays silence while the UI shows "playing". It resumes on its own
//!   once the holder lets go. So "are we hogging it" is read from CoreAudio
//!   (`kAudioDevicePropertyHogMode == our pid`), never inferred from mpv.
//! - Rates are compared end to end: source (`audio-params`) vs AO
//!   (`audio-out-params`) vs the device's nominal rate.
//!
//! While the mode is on, a watchdog thread emits `engine-output` whenever that
//! picture changes. The frontend folds it into the badge state.

use super::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Weak;
use std::time::Duration;

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

/// The device bit-perfect mode is pinned to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePin {
    pub uid: String,
    pub name: String,
    /// The device exposes a settable hardware volume. Informational (filled by
    /// `default_output_device`); ignored when the frontend sends a pin back.
    #[serde(default)]
    pub has_volume: bool,
}

impl DevicePin {
    /// mpv's `audio-device` value for this pin.
    pub fn mpv_device(&self) -> String {
        format!("coreaudio/{}", self.uid)
    }
}

/// What CoreAudio says about the pinned device right now.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeviceStatus {
    pub present: bool,
    /// Process holding hog mode, if any (CoreAudio reports -1 for nobody).
    pub hog_pid: Option<i32>,
    pub nominal_rate: Option<f64>,
    /// Available nominal rates as inclusive ranges (discrete rates have min == max).
    pub rate_ranges: Vec<(f64, f64)>,
    /// The device's own hardware volume (0..1), when it exposes a settable one.
    pub volume: Option<f64>,
}

impl DeviceStatus {
    pub fn max_rate(&self) -> Option<f64> {
        self.rate_ranges.iter().map(|&(_, max)| max).fold(None, |acc, r| Some(acc.map_or(r, |a: f64| a.max(r))))
    }

    pub fn supports_rate(&self, rate: f64) -> bool {
        self.rate_ranges.iter().any(|&(min, max)| rate >= min - 0.5 && rate <= max + 0.5)
    }
}

/// The current macOS default output device, for pinning at enable time.
pub fn default_output_device() -> Option<DevicePin> {
    platform::default_output_device()
}

pub fn device_status(uid: &str) -> DeviceStatus {
    platform::device_status(uid)
}

/// Set the device's own hardware volume (0..1). This is what Viboplr's volume
/// control drives in bit-perfect mode: the level is applied by the device, so
/// the samples mpv sends stay untouched.
pub fn set_device_volume(uid: &str, volume: f64) -> Result<(), String> {
    platform::set_device_volume(uid, volume.clamp(0.0, 1.0))
}

/// Name of a running process, for the "in use by …" copy.
pub fn process_name(pid: i32) -> Option<String> {
    platform::process_name(pid)
}

/// Build the `engine-output` payload from the pin, the device status and the
/// active deck's rates. Pure, so the decision inputs are testable without audio.
pub fn output_payload(
    pin: &DevicePin,
    status: &DeviceStatus,
    our_pid: i32,
    track_key: Option<&str>,
    src_rate: Option<i64>,
    out_rate: Option<i64>,
    holder_name: Option<String>,
) -> serde_json::Value {
    let hogged_by_us = status.hog_pid == Some(our_pid);
    let holder_pid = status.hog_pid.filter(|&p| p != our_pid);
    json!({
        "deviceUid": pin.uid,
        "deviceName": pin.name,
        "devicePresent": status.present,
        "hoggedByUs": hogged_by_us,
        "holderPid": holder_pid,
        "holderName": if holder_pid.is_some() { holder_name } else { None },
        "trackKey": track_key,
        "srcRate": src_rate,
        "outRate": out_rate,
        "deviceRate": status.nominal_rate.map(|r| r.round() as i64),
        "deviceMaxRate": status.max_rate().map(|r| r.round() as i64),
        "rateSupported": src_rate.map(|r| status.supports_rate(r as f64)),
        // Two decimals: the watchdog emits on change, and scalar noise below
        // a slider step would otherwise re-emit every second.
        "deviceVolume": status.volume.map(|v| (v * 100.0).round() / 100.0),
    })
}

/// Watchdog: while bit-perfect mode is on (and this thread's generation is
/// current), emit `engine-output` whenever the verified picture changes. Also
/// emits once immediately so the frontend isn't left without a state.
pub fn spawn_watchdog(engine: Weak<Engine>, generation: u64) {
    let spawned = std::thread::Builder::new()
        .name("mpv-engine-output".into())
        .spawn(move || {
            let our_pid = std::process::id() as i32;
            let mut last: Option<serde_json::Value> = None;
            loop {
                let Some(engine) = engine.upgrade() else { return };
                let Some((pin, track_key, active)) = engine.bit_perfect_snapshot(generation) else {
                    return; // mode turned off or superseded
                };
                let status = device_status(&pin.uid);
                let holder_name = status.hog_pid.filter(|&p| p != our_pid && p > 0).and_then(process_name);
                let mpv = &engine.decks[active].mpv;
                let rate = |name: &str| mpv.get_property::<i64>(name).ok().filter(|&v| v > 0);
                let (src_rate, out_rate) = if track_key.is_some() {
                    (rate("audio-params/samplerate"), rate("audio-out-params/samplerate"))
                } else {
                    (None, None)
                };
                let payload = output_payload(&pin, &status, our_pid, track_key.as_deref(), src_rate, out_rate, holder_name);
                if last.as_ref() != Some(&payload) {
                    log::info!("mpv-engine: output {payload}");
                    (engine.sink)("engine-output", payload.clone());
                    last = Some(payload);
                }
                drop(engine);
                std::thread::sleep(WATCHDOG_INTERVAL);
            }
        });
    if let Err(e) = spawned {
        log::error!("mpv-engine: failed to spawn output watchdog: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{DevicePin, DeviceStatus};

    pub fn default_output_device() -> Option<DevicePin> {
        None
    }

    pub fn device_status(_uid: &str) -> DeviceStatus {
        DeviceStatus::default()
    }

    pub fn set_device_volume(_uid: &str, _volume: f64) -> Result<(), String> {
        Err("device volume is not supported on this platform".into())
    }

    pub fn process_name(_pid: i32) -> Option<String> {
        None
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! Minimal hand-declared CoreAudio bindings — just enough to read device
    //! properties. System frameworks, so no crate dependency.
    use super::{DevicePin, DeviceStatus};
    use std::ffi::{c_char, c_void};

    type AudioObjectID = u32;
    type OSStatus = i32;
    type CFStringRef = *const c_void;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct AudioValueRange {
        min: f64,
        max: f64,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectHasProperty(id: AudioObjectID, address: *const AudioObjectPropertyAddress) -> u8;
        fn AudioObjectIsPropertySettable(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            settable: *mut u8,
        ) -> OSStatus;
        fn AudioObjectSetPropertyData(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: u32,
            data: *const c_void,
        ) -> OSStatus;
        fn AudioObjectGetPropertyData(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> OSStatus;
        fn AudioObjectGetPropertyDataSize(
            id: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
        ) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, len: isize, encoding: u32) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
    }

    const SYSTEM_OBJECT: AudioObjectID = 1;
    const SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const SCOPE_OUTPUT: u32 = fourcc(b"outp");
    const ELEMENT_MAIN: u32 = 0;
    const DEFAULT_OUTPUT_DEVICE: u32 = fourcc(b"dOut");
    const DEVICES: u32 = fourcc(b"dev#");
    const DEVICE_UID: u32 = fourcc(b"uid ");
    const OBJECT_NAME: u32 = fourcc(b"lnam");
    const HOG_MODE: u32 = fourcc(b"oink");
    const NOMINAL_RATE: u32 = fourcc(b"nsrt");
    const AVAILABLE_RATES: u32 = fourcc(b"nsr#");
    const VOLUME_SCALAR: u32 = fourcc(b"volm");
    const CF_UTF8: u32 = 0x0800_0100;

    fn addr(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress { selector, scope, element: ELEMENT_MAIN }
    }

    fn get<T: Default>(id: AudioObjectID, selector: u32, scope: u32) -> Option<T> {
        let a = addr(selector, scope);
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut value as *mut T as *mut c_void)
        };
        (status == 0).then_some(value)
    }

    fn get_array<T: Default + Clone>(id: AudioObjectID, selector: u32, scope: u32) -> Vec<T> {
        let a = addr(selector, scope);
        let mut size = 0u32;
        if unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) } != 0 {
            return Vec::new();
        }
        let mut out = vec![T::default(); size as usize / std::mem::size_of::<T>()];
        let status = unsafe {
            AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, out.as_mut_ptr() as *mut c_void)
        };
        if status != 0 {
            return Vec::new();
        }
        out.truncate(size as usize / std::mem::size_of::<T>());
        out
    }

    /// A CFString-valued property, copied out and released.
    fn get_string(id: AudioObjectID, selector: u32) -> Option<String> {
        let a = addr(selector, SCOPE_GLOBAL);
        let mut s: CFStringRef = std::ptr::null();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut s as *mut CFStringRef as *mut c_void)
        };
        if status != 0 || s.is_null() {
            return None;
        }
        let mut buf = [0 as c_char; 512];
        let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, CF_UTF8) };
        unsafe { CFRelease(s) };
        if ok == 0 {
            return None;
        }
        let cstr = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) };
        Some(cstr.to_string_lossy().into_owned())
    }

    /// The elements carrying a settable output volume: the master (0) when the
    /// device has one, else the per-channel pair (1, 2). Empty = no volume.
    fn volume_elements(dev: AudioObjectID) -> Vec<u32> {
        let settable = |element: u32| {
            let a = AudioObjectPropertyAddress { selector: VOLUME_SCALAR, scope: SCOPE_OUTPUT, element };
            if unsafe { AudioObjectHasProperty(dev, &a) } == 0 {
                return false;
            }
            let mut ok = 0u8;
            let status = unsafe { AudioObjectIsPropertySettable(dev, &a, &mut ok) };
            status == 0 && ok != 0
        };
        if settable(ELEMENT_MAIN) {
            vec![ELEMENT_MAIN]
        } else {
            [1, 2].into_iter().filter(|&e| settable(e)).collect()
        }
    }

    fn read_volume(dev: AudioObjectID, elements: &[u32]) -> Option<f64> {
        let values: Vec<f64> = elements
            .iter()
            .filter_map(|&element| {
                let a = AudioObjectPropertyAddress { selector: VOLUME_SCALAR, scope: SCOPE_OUTPUT, element };
                let mut v = 0f32;
                let mut size = std::mem::size_of::<f32>() as u32;
                let status = unsafe {
                    AudioObjectGetPropertyData(dev, &a, 0, std::ptr::null(), &mut size, &mut v as *mut f32 as *mut c_void)
                };
                (status == 0).then_some(v as f64)
            })
            .collect();
        (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
    }

    pub fn set_device_volume(uid: &str, volume: f64) -> Result<(), String> {
        let dev = find_device(uid).ok_or_else(|| format!("output device {uid} not found"))?;
        let elements = volume_elements(dev);
        if elements.is_empty() {
            return Err("this device has no controllable volume".into());
        }
        let v = volume as f32;
        for element in elements {
            let a = AudioObjectPropertyAddress { selector: VOLUME_SCALAR, scope: SCOPE_OUTPUT, element };
            let status = unsafe {
                AudioObjectSetPropertyData(dev, &a, 0, std::ptr::null(), std::mem::size_of::<f32>() as u32, &v as *const f32 as *const c_void)
            };
            if status != 0 {
                return Err(format!("setting the device volume failed (OSStatus {status})"));
            }
        }
        Ok(())
    }

    fn find_device(uid: &str) -> Option<AudioObjectID> {
        get_array::<AudioObjectID>(SYSTEM_OBJECT, DEVICES, SCOPE_GLOBAL)
            .into_iter()
            .find(|&d| get_string(d, DEVICE_UID).as_deref() == Some(uid))
    }

    pub fn default_output_device() -> Option<DevicePin> {
        let dev = get::<AudioObjectID>(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL)?;
        let uid = get_string(dev, DEVICE_UID)?;
        let name = get_string(dev, OBJECT_NAME).unwrap_or_else(|| uid.clone());
        let has_volume = !volume_elements(dev).is_empty();
        Some(DevicePin { uid, name, has_volume })
    }

    pub fn device_status(uid: &str) -> DeviceStatus {
        let Some(dev) = find_device(uid) else {
            return DeviceStatus::default();
        };
        // Output streams only — a device that lost them (e.g. reconfigured) is
        // as good as gone for playback.
        let present = !get_array::<AudioObjectID>(dev, fourcc(b"stm#"), SCOPE_OUTPUT).is_empty();
        DeviceStatus {
            present,
            hog_pid: get::<i32>(dev, HOG_MODE, SCOPE_GLOBAL).filter(|&p| p > 0),
            nominal_rate: get::<f64>(dev, NOMINAL_RATE, SCOPE_GLOBAL),
            rate_ranges: get_array::<AudioValueRange>(dev, AVAILABLE_RATES, SCOPE_GLOBAL)
                .into_iter()
                .map(|r| (r.min, r.max))
                .collect(),
            volume: read_volume(dev, &volume_elements(dev)),
        }
    }

    pub fn process_name(pid: i32) -> Option<String> {
        let mut buf = [0u8; 256];
        let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
        if n <= 0 {
            return None;
        }
        Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin() -> DevicePin {
        DevicePin { uid: "BuiltInSpeakerDevice".into(), name: "MacBook Pro Speakers".into(), has_volume: true }
    }

    fn status(hog: Option<i32>, nominal: f64, ranges: &[(f64, f64)]) -> DeviceStatus {
        DeviceStatus { present: true, hog_pid: hog, nominal_rate: Some(nominal), rate_ranges: ranges.to_vec(), volume: Some(0.504) }
    }

    #[test]
    fn test_payload_hogged_by_us_hides_holder() {
        let st = status(Some(42), 96000.0, &[(44100.0, 44100.0), (96000.0, 96000.0)]);
        let p = output_payload(&pin(), &st, 42, Some("q:1"), Some(96000), Some(96000), Some("viboplr".into()));
        assert_eq!(p["hoggedByUs"], true);
        assert!(p["holderPid"].is_null());
        assert!(p["holderName"].is_null());
        assert_eq!(p["deviceRate"], 96000);
        assert_eq!(p["deviceMaxRate"], 96000);
        assert_eq!(p["rateSupported"], true);
        assert_eq!(p["deviceVolume"], 0.5, "rounded to two decimals");
    }

    #[test]
    fn test_payload_reports_other_holder() {
        let st = status(Some(7), 44100.0, &[(44100.0, 48000.0)]);
        let p = output_payload(&pin(), &st, 42, Some("q:1"), Some(96000), Some(44100), Some("Audirvana".into()));
        assert_eq!(p["hoggedByUs"], false);
        assert_eq!(p["holderPid"], 7);
        assert_eq!(p["holderName"], "Audirvana");
        assert_eq!(p["rateSupported"], false, "96k is outside a 44.1–48k range");
    }

    #[test]
    fn test_payload_idle_has_no_rates() {
        let st = status(None, 48000.0, &[(48000.0, 48000.0)]);
        let p = output_payload(&pin(), &st, 42, None, None, None, None);
        assert!(p["trackKey"].is_null());
        assert!(p["srcRate"].is_null());
        assert!(p["rateSupported"].is_null());
    }

    #[test]
    fn test_mpv_device_string() {
        assert_eq!(pin().mpv_device(), "coreaudio/BuiltInSpeakerDevice");
    }
}
