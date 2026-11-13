//! Window drag for the mini player on macOS.
//!
//! `performWindowDragWithEvent:` uses the event's location as the point the
//! cursor holds on to, so that event has to be the mouse-down, in this window's
//! coordinates. tao's `start_dragging` passes along whatever `NSApp.currentEvent`
//! is by the time the IPC call arrives. The webview's mouse-down travels through
//! the WebContent process and back first, so by then the current event is often
//! a different one. tao also rebuilds one event kind from
//! `NSEvent::mouseLocation`, which is in *screen* coordinates, as a window
//! event. Either way AppKit gets a grab point that isn't under the cursor, and
//! the window jumps on the first move so that point lands there. In the mini
//! window that point came out as the top-left corner.
//!
//! So: use the current event only when it really is this window's left
//! mouse-down or drag. Otherwise build a mouse-down at the cursor's current
//! position in window coordinates (`mouseLocationOutsideOfEventStream`).

use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
use objc2_foundation::{MainThreadMarker, NSProcessInfo};

pub fn start(ns_window: &NSWindow, mtm: MainThreadMarker) -> Result<(), String> {
    let window_number = ns_window.windowNumber();
    let current = NSApplication::sharedApplication(mtm).currentEvent();
    let usable = current.as_ref().filter(|e| {
        let kind = e.r#type();
        (kind == NSEventType::LeftMouseDown || kind == NSEventType::LeftMouseDragged)
            && e.windowNumber() == window_number
    });
    if let Some(event) = usable {
        ns_window.performWindowDragWithEvent(event);
        return Ok(());
    }

    log::debug!(
        "Window drag: current event is {:?}, building a mouse-down at the cursor",
        current.as_ref().map(|e| e.r#type().0)
    );
    let flags = current
        .as_ref()
        .map(|e| e.modifierFlags())
        .unwrap_or(NSEventModifierFlags::empty());
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDown,
        ns_window.mouseLocationOutsideOfEventStream(),
        flags,
        NSProcessInfo::processInfo().systemUptime(),
        window_number,
        None,
        0,
        1,
        1.0,
    )
    .ok_or_else(|| "Couldn't build the mouse-down for a window drag".to_string())?;
    ns_window.performWindowDragWithEvent(&event);
    Ok(())
}
