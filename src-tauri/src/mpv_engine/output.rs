//! Bit-perfect output: device pinning and verification.
//!
//! Bit-perfect mode pins the output to one device (CoreAudio UID / WASAPI
//! endpoint id) and then *verifies* the path rather than trusting intent. Live
//! spikes showed why each part is needed.
//!
//! macOS (2026-09-27):
//! - `audio-device=auto` drifts: macOS moves the system default away from a
//!   hogged device, so the next AO open follows the default elsewhere.
//! - When another process holds the pinned device, mpv only warns
//!   (`failed to set hogmode`), still reports `current-ao=coreaudio_exclusive`,
//!   and then plays silence while the UI shows "playing". It resumes on its own
//!   once the holder lets go. So "are we hogging it" is read from CoreAudio
//!   (`kAudioDevicePropertyHogMode == our pid`), never inferred from mpv.
//!
//! Windows (2026-10-01, `probe_wasapi_exclusive`, Sound BlasterX G6):
//! - `audio-device=wasapi/<endpoint id>` pins; with `gapless-audio=weak` the
//!   exclusive stream follows each source rate (96k -> 44.1k observed).
//! - The opposite of macOS on a busy device: while another client holds the
//!   endpoint exclusively, mpv's open fails outright (`AUDCLNT_E_DEVICE_IN_USE`
//!   -> `MPV_ERROR_AO_INIT_FAILED`) and the file ends. Nothing reports *who*
//!   holds it. So ownership is inferred the other way round: mpv never falls
//!   back to shared once `audio-exclusive` is set, so an open WASAPI AO **is**
//!   the exclusive stream. The engine keeps the track and retries while busy
//!   (`EngineState::device_busy`), which the payload reports as `deviceBusy`.
//! - Shared-mode apps don't block it: an exclusive open evicts them.
//! - Exclusive mode has no mixer, so the stream's rate is the device's rate;
//!   there is no separate nominal rate to read (`deviceRate` stays null).
//!
//! Rates are compared end to end: source (`audio-params`) vs AO
//! (`audio-out-params`) vs the device's nominal rate where one exists.
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
    /// mpv's `audio-device` value for this pin: the AO name plus the device's
    /// id in that API (CoreAudio UID / WASAPI endpoint id).
    pub fn mpv_device(&self) -> String {
        let ao = if cfg!(windows) { "wasapi" } else { "coreaudio" };
        format!("{ao}/{}", self.uid)
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

/// What the watchdog needs from the engine each tick.
pub struct Snapshot {
    pub pin: DevicePin,
    pub track_key: Option<String>,
    pub active: usize,
    /// The pinned device refused to open (held by another process).
    pub busy: bool,
}

/// Who holds the pinned device, from the platform's point of view.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ownership {
    pub ours: bool,
    /// Another process known to hold it (CoreAudio only).
    pub holder_pid: Option<i32>,
    /// It refused to open for us, holder unknown (WASAPI).
    pub busy: bool,
}

/// Ownership from what each platform can actually observe. CoreAudio names
/// the hog-mode pid; WASAPI names nobody, so there it's inferred from mpv:
/// `audio-exclusive` never falls back to shared, so an open AO that isn't
/// waiting on a busy device is our exclusive stream.
pub fn ownership(status: &DeviceStatus, our_pid: i32, pid_reported: bool, ao_open: bool, busy: bool) -> Ownership {
    if pid_reported {
        return Ownership {
            ours: status.hog_pid == Some(our_pid),
            holder_pid: status.hog_pid.filter(|&p| p != our_pid),
            busy,
        };
    }
    Ownership { ours: ao_open && !busy, holder_pid: None, busy }
}

/// The current default output device, for pinning at enable time.
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
    owner: Ownership,
    track_key: Option<&str>,
    src_rate: Option<i64>,
    out_rate: Option<i64>,
    holder_name: Option<String>,
) -> serde_json::Value {
    json!({
        "deviceUid": pin.uid,
        "deviceName": pin.name,
        "devicePresent": status.present,
        "hoggedByUs": owner.ours,
        "holderPid": owner.holder_pid,
        "holderName": if owner.holder_pid.is_some() { holder_name } else { None },
        "deviceBusy": owner.busy,
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
                let Some(Snapshot { pin, track_key, active, busy }) = engine.bit_perfect_snapshot(generation) else {
                    return; // mode turned off or superseded
                };
                let status = device_status(&pin.uid);
                let holder_name = status.hog_pid.filter(|&p| p != our_pid && p > 0).and_then(process_name);
                let mpv = &engine.decks[active].mpv;
                let ao_open = track_key.is_some()
                    && mpv.get_property::<String>("current-ao").map(|ao| !ao.is_empty()).unwrap_or(false);
                // The device opened after all: stop waiting on it.
                let busy = if busy && ao_open {
                    engine.clear_device_busy();
                    false
                } else {
                    busy
                };
                if busy {
                    engine.retry_busy_device(false);
                }
                let owner = ownership(&status, our_pid, cfg!(target_os = "macos"), ao_open, busy);
                let rate = |name: &str| mpv.get_property::<i64>(name).ok().filter(|&v| v > 0);
                let (src_rate, out_rate) = if track_key.is_some() && !busy {
                    (rate("audio-params/samplerate"), rate("audio-out-params/samplerate"))
                } else {
                    (None, None)
                };
                let payload = output_payload(&pin, &status, owner, track_key.as_deref(), src_rate, out_rate, holder_name);
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

#[cfg(windows)]
mod platform {
    //! WASAPI through the `windows` crate: the default render endpoint, its
    //! state, the rates it accepts in exclusive mode and its hardware volume.
    //!
    //! There is no Windows counterpart of CoreAudio's hog-mode pid — nothing
    //! reports which process holds an endpoint exclusively — so `hog_pid` is
    //! always `None` here and ownership comes from mpv instead (see
    //! `Ownership::from_mpv`).
    use super::{DevicePin, DeviceStatus};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::core::HSTRING;
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_SHAREMODE_EXCLUSIVE, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
        WAVEFORMATEXTENSIBLE_0,
    };
    use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
    use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED, STGM_READ,
    };

    const ENDPOINT_HARDWARE_SUPPORT_VOLUME: u32 = 0x1;
    /// Rates probed for exclusive-mode support. WASAPI has no "list the
    /// device's rates" call, only "would you take this exact format".
    const PROBE_RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];

    /// Exclusive-mode rates per endpoint id, probed once. Probing asks the
    /// driver ~40 questions, and the watchdog polls every second.
    static RATES: Mutex<Option<HashMap<String, Vec<(f64, f64)>>>> = Mutex::new(None);

    /// COM for the current thread, for the duration of one call. The command
    /// thread may already be in an STA (`RPC_E_CHANGED_MODE`): COM is usable
    /// there as is, and only a successful init of ours is balanced.
    struct Com(bool);

    impl Com {
        fn init() -> Self {
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn enumerator() -> Option<IMMDeviceEnumerator> {
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()
    }

    fn find_device(uid: &str) -> Option<IMMDevice> {
        unsafe { enumerator()?.GetDevice(&HSTRING::from(uid)) }.ok()
    }

    fn device_id(dev: &IMMDevice) -> Option<String> {
        let id = unsafe { dev.GetId() }.ok()?;
        let s = unsafe { id.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(id.0 as *const _)) };
        s
    }

    fn friendly_name(dev: &IMMDevice) -> Option<String> {
        let store = unsafe { dev.OpenPropertyStore(STGM_READ) }.ok()?;
        let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }.ok()?;
        let name = value.to_string();
        (!name.is_empty()).then_some(name)
    }

    /// The endpoint volume, only when the device applies it in hardware:
    /// exclusive mode bypasses the audio engine, so a software-only endpoint
    /// volume would do nothing to what reaches the DAC.
    fn hardware_volume(dev: &IMMDevice) -> Option<IAudioEndpointVolume> {
        let vol: IAudioEndpointVolume = unsafe { dev.Activate(CLSCTX_ALL, None) }.ok()?;
        let mask = unsafe { vol.QueryHardwareSupport() }.ok()?;
        (mask & ENDPOINT_HARDWARE_SUPPORT_VOLUME != 0).then_some(vol)
    }

    /// PCM/float format for an exclusive-mode support query.
    fn wave_format(rate: u32, bits: u16, valid: u16, float: bool) -> WAVEFORMATEXTENSIBLE {
        let block = 2 * bits / 8;
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
                nChannels: 2,
                nSamplesPerSec: rate,
                nAvgBytesPerSec: rate * block as u32,
                nBlockAlign: block,
                wBitsPerSample: bits,
                cbSize: (std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()) as u16,
            },
            Samples: WAVEFORMATEXTENSIBLE_0 { wValidBitsPerSample: valid },
            dwChannelMask: 0x3, // front left | front right
            SubFormat: if float { KSDATAFORMAT_SUBTYPE_IEEE_FLOAT } else { KSDATAFORMAT_SUBTYPE_PCM },
        }
    }

    fn probe_rates(dev: &IMMDevice) -> Vec<(f64, f64)> {
        let Ok(client) = (unsafe { dev.Activate::<IAudioClient>(CLSCTX_ALL, None) }) else {
            return Vec::new();
        };
        // Any sample format at the rate will do: mpv picks the format itself,
        // the question here is only whether the rate is reachable at all.
        let formats: [(u16, u16, bool); 5] = [(32, 24, false), (24, 24, false), (32, 32, false), (16, 16, false), (32, 32, true)];
        PROBE_RATES
            .iter()
            .filter(|&&rate| {
                formats.iter().any(|&(bits, valid, float)| {
                    let fmt = wave_format(rate, bits, valid, float);
                    let hr = unsafe {
                        client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &fmt.Format, None)
                    };
                    hr.is_ok()
                })
            })
            .map(|&r| (r as f64, r as f64))
            .collect()
    }

    /// Cached exclusive-mode rates. An empty probe (e.g. the device was busy)
    /// isn't cached, so a later call can still get an answer.
    fn rates(uid: &str, dev: &IMMDevice) -> Vec<(f64, f64)> {
        let mut cache = RATES.lock().unwrap();
        let map = cache.get_or_insert_with(HashMap::new);
        if let Some(r) = map.get(uid) {
            return r.clone();
        }
        let probed = probe_rates(dev);
        if !probed.is_empty() {
            map.insert(uid.to_string(), probed.clone());
        }
        probed
    }

    pub fn default_output_device() -> Option<DevicePin> {
        let _com = Com::init();
        let dev = unsafe { enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
        let uid = device_id(&dev)?;
        let name = friendly_name(&dev).unwrap_or_else(|| uid.clone());
        let has_volume = hardware_volume(&dev).is_some();
        // Probe the rates now, while nobody holds the device exclusively yet.
        rates(&uid, &dev);
        Some(DevicePin { uid, name, has_volume })
    }

    pub fn device_status(uid: &str) -> DeviceStatus {
        let _com = Com::init();
        let Some(dev) = find_device(uid) else {
            return DeviceStatus::default();
        };
        // Disabled / unplugged endpoints stay enumerable; only ACTIVE plays.
        let present = unsafe { dev.GetState() }.map(|s| s == DEVICE_STATE_ACTIVE).unwrap_or(false);
        if !present {
            return DeviceStatus::default();
        }
        DeviceStatus {
            present,
            hog_pid: None,
            // In exclusive mode the stream's format *is* the device's — there
            // is no mixer in between to run at some other rate — and nothing
            // reports it separately, so the out rate stands for it.
            nominal_rate: None,
            rate_ranges: rates(uid, &dev),
            volume: hardware_volume(&dev)
                .and_then(|v| unsafe { v.GetMasterVolumeLevelScalar() }.ok())
                .map(|v| v as f64),
        }
    }

    pub fn set_device_volume(uid: &str, volume: f64) -> Result<(), String> {
        let _com = Com::init();
        let dev = find_device(uid).ok_or_else(|| format!("output device {uid} not found"))?;
        let vol = hardware_volume(&dev).ok_or("this device has no controllable volume")?;
        unsafe { vol.SetMasterVolumeLevelScalar(volume as f32, std::ptr::null()) }
            .map_err(|e| format!("setting the device volume failed: {e}"))
    }

    pub fn process_name(_pid: i32) -> Option<String> {
        None
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
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
        let p = output_payload(&pin(), &st, ownership(&st, 42, true, true, false), Some("q:1"), Some(96000), Some(96000), Some("viboplr".into()));
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
        let p = output_payload(&pin(), &st, ownership(&st, 42, true, true, false), Some("q:1"), Some(96000), Some(44100), Some("Audirvana".into()));
        assert_eq!(p["hoggedByUs"], false);
        assert_eq!(p["holderPid"], 7);
        assert_eq!(p["holderName"], "Audirvana");
        assert_eq!(p["rateSupported"], false, "96k is outside a 44.1–48k range");
    }

    #[test]
    fn test_payload_idle_has_no_rates() {
        let st = status(None, 48000.0, &[(48000.0, 48000.0)]);
        let p = output_payload(&pin(), &st, ownership(&st, 42, true, false, false), None, None, None, None);
        assert!(p["trackKey"].is_null());
        assert!(p["srcRate"].is_null());
        assert!(p["rateSupported"].is_null());
    }

    #[cfg(windows)]
    fn probe_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("viboplr-wasapi-probe");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 20s of 24-bit stereo silence at `rate`, for the device probes.
    #[cfg(windows)]
    fn silence_wav(rate: u32) -> String {
        let path = probe_dir().join(format!("silence-{rate}.wav"));
        let data_len = rate * 20 * 2 * 3;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&2u16.to_le_bytes()); // stereo
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 6).to_le_bytes());
        b.extend_from_slice(&6u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        b.resize(b.len() + data_len as usize, 0);
        std::fs::write(&path, b).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// Windows: Bit-perfect mode against a device another client already
    /// holds exclusively. Expect `deviceBusy` (not an engine error) while it's
    /// held, then the engine to reopen it by itself — at the source rate —
    /// once the holder lets go. Plays silence.
    /// `cargo test --lib probe_bit_perfect_busy_device -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn probe_bit_perfect_busy_device() {
        use super::super::api::Mpv;
        use super::super::{DspSettings, Engine};
        use std::sync::{mpsc, Arc};
        let pin = default_output_device().expect("default device");
        let f96 = silence_wav(96000);
        let holder = Mpv::with_initializer(|init| {
            init.set_property("vo", "null")?;
            init.set_property("video", "no")?;
            init.set_property("idle", "yes")?;
            init.set_property("audio-exclusive", true)?;
            init.set_property("audio-device", pin.mpv_device().as_str())?;
            Ok(())
        })
        .expect("mpv");
        holder.command("loadfile", &[&silence_wav(44100)]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2000));
        eprintln!("holder current-ao={:?}", holder.get_property::<String>("current-ao"));

        let (tx, rx) = mpsc::channel::<(String, serde_json::Value)>();
        let sink: super::super::EventSink = Arc::new(move |event, payload| {
            let _ = tx.send((event.to_string(), payload));
        });
        let engine = Engine::new(sink, None, None).expect("engine");
        let dsp = DspSettings { bit_perfect: Some(pin.clone()), ..Default::default() };
        engine.apply_bit_perfect(Some(&pin), &dsp).expect("bit-perfect on");
        engine.play(&f96, None, "q:1", None, 0.0, false, false).expect("play");

        let watch = |label: &str, secs: u64| {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
            while let Some(left) = until.checked_duration_since(std::time::Instant::now()) {
                if let Ok((event, payload)) = rx.recv_timeout(left) {
                    if event != "engine-position" {
                        eprintln!("[{label}] {event}: {payload}");
                    }
                }
            }
        };
        watch("held", 6);
        holder.command("stop", &[]).unwrap();
        eprintln!("--- holder released ---");
        watch("released", 6);
        // The endpoint volume (what Windows' volume keys and flyout drive) on
        // the exclusively held device: settable, and it reads back.
        let before = device_status(&pin.uid).volume.expect("hardware volume");
        set_device_volume(&pin.uid, before - 0.02).expect("set while held");
        eprintln!("volume while held: {before} -> {:?}", device_status(&pin.uid).volume);
        set_device_volume(&pin.uid, before).expect("restore");
        engine.stop().ok();
    }

    /// Windows spike: what WASAPI exclusive through mpv actually does on this
    /// machine's default endpoint — pinning by endpoint id, rate following,
    /// and what a second exclusive client sees while the first holds it.
    /// Plays silence. `cargo test --lib probe_wasapi_exclusive -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn probe_wasapi_exclusive() {
        use super::super::api::Mpv;
        let pin = default_output_device().expect("default device");
        eprintln!("pin: {pin:?}\nstatus: {:?}", device_status(&pin.uid));
        let dir = probe_dir();
        let (f96, f44) = (silence_wav(96000), silence_wav(44100));
        let deck = |exclusive: bool| {
            Mpv::with_initializer(|init| {
                init.set_property("vo", "null")?;
                init.set_property("video", "no")?;
                init.set_property("idle", "yes")?;
                init.set_property("terminal", "no")?;
                init.set_property("gapless-audio", "weak")?;
                init.set_property("audio-exclusive", exclusive)?;
                init.set_property("audio-device", pin.mpv_device().as_str())?;
                Ok(())
            })
            .expect("mpv")
        };
        let report = |label: &str, m: &Mpv| {
            let s = |p: &str| m.get_property::<String>(p).unwrap_or_else(|e| format!("<{e}>"));
            eprintln!(
                "[{label}] current-ao={} src={} out={} outfmt={} time-pos={} idle={} status={:?}",
                s("current-ao"),
                s("audio-params/samplerate"),
                s("audio-out-params/samplerate"),
                s("audio-out-params/format"),
                s("time-pos"),
                s("idle-active"),
                device_status(&pin.uid)
            );
        };
        let drain = |label: &str, m: &Mpv| {
            while let Some(ev) = m.wait_event(0.0) {
                eprintln!("[{label}] event {:?}", ev.map(|e| format!("{e:?}")));
            }
        };
        let wait = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));

        // Shared first, then exclusive: does another app merely *playing*
        // (shared mode) block exclusive access?
        let s = deck(false);
        s.command("loadfile", &[&f44]).unwrap();
        wait(2000);
        drain("S", &s);
        report("S shared first", &s);
        let x = deck(true);
        x.set_property("log-file", dir.join("x.log").to_string_lossy().as_ref()).ok();
        x.command("loadfile", &[&f96]).unwrap();
        wait(3000);
        drain("X", &x);
        report("X exclusive while S plays shared", &x);
        report("S after X tried", &s);
        x.command("stop", &[]).ok();
        s.command("stop", &[]).ok();
        wait(1000);
        drop(x);
        drop(s);

        let a = deck(true);
        a.command("loadfile", &[&f96]).unwrap();
        wait(2500);
        drain("A", &a);
        report("A 96k exclusive", &a);
        a.command("loadfile", &[&f44]).unwrap();
        wait(2500);
        report("A 44.1k after 96k", &a);

        let b = deck(true);
        b.command("loadfile", &[&f96]).unwrap();
        wait(3000);
        drain("B", &b);
        report("B exclusive while A holds", &b);

        let c = deck(false);
        c.command("loadfile", &[&f96]).unwrap();
        wait(3000);
        drain("C", &c);
        report("C shared while A holds", &c);

        a.command("stop", &[]).unwrap();
        wait(3000);
        drain("B", &b);
        report("B after A stopped", &b);
        report("C after A stopped", &c);
        b.command("ao-reload", &[]).ok();
        wait(2500);
        drain("B", &b);
        report("B after ao-reload", &b);
    }

    #[test]
    fn test_wasapi_ownership_is_inferred_from_the_open_output() {
        // WASAPI reports no holder pid: an open exclusive AO is ours, a busy
        // device is nobody we can name.
        let st = DeviceStatus { present: true, ..Default::default() };
        assert_eq!(ownership(&st, 42, false, true, false), Ownership { ours: true, holder_pid: None, busy: false });
        assert_eq!(ownership(&st, 42, false, false, true), Ownership { ours: false, holder_pid: None, busy: true });
        assert_eq!(ownership(&st, 42, false, false, false), Ownership { ours: false, holder_pid: None, busy: false });
        let p = output_payload(&pin(), &st, ownership(&st, 42, false, false, true), Some("q:1"), None, None, None);
        assert_eq!(p["deviceBusy"], true);
        assert_eq!(p["hoggedByUs"], false);
        assert!(p["holderPid"].is_null());
        assert!(p["deviceRate"].is_null(), "WASAPI exclusive has no separate nominal rate");
    }

    #[test]
    fn test_coreaudio_ownership_ignores_the_open_output() {
        // mpv reports an open exclusive AO even while another process hogs the
        // device (the macOS spike), so CoreAudio's pid is the only authority.
        let st = status(Some(7), 44100.0, &[(44100.0, 48000.0)]);
        assert_eq!(ownership(&st, 42, true, true, false), Ownership { ours: false, holder_pid: Some(7), busy: false });
    }

    #[test]
    fn test_mpv_device_string() {
        let ao = if cfg!(windows) { "wasapi" } else { "coreaudio" };
        assert_eq!(pin().mpv_device(), format!("{ao}/BuiltInSpeakerDevice"));
    }
}
