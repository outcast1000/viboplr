// Mock Meter Plugin (debugOnly: loads only with Settings → Debug → Debug mode on)
//
// A bare level meter in a sidebar view, fed by api.playback.onLevel: one row
// per channel for peak and one for RMS, with the dBFS figure and a peak hold.
// It exists so the host's meter (mpv astats → engine-level → levelStore →
// plugin API) can be watched working without a visualizer to draw it.
//
// The host measures only while someone is subscribed, so the view has a
// switch: off releases the subscription and the engine stops measuring.
// Readings arrive only on the native (mpv) engine; on the browser engine,
// paused or stopped, the view says so instead of drawing a stale level.

var VIEW_ID = "mock-meter-view";
var FLOOR_DB = -60; // the bars' zero; anything quieter draws empty
var HOLD_MS = 1500;  // how long a channel's peak hold stays up

function activate(api) {
  var enabled = true;
  var unsubscribe = null;
  var level = null;     // latest reading, or null when there is none
  var readings = 0;
  var lastAt = 0;
  var holds = [];       // per channel: { db, at }

  function channelName(i, count) {
    if (count === 1) return "Mono";
    if (count === 2) return i === 0 ? "L" : "R";
    return "Ch " + (i + 1);
  }

  function fmtDb(db) {
    if (db <= -90) return "-inf dB";
    return (db > 0 ? "+" : "") + db.toFixed(1) + " dB";
  }

  function toBar(db) {
    return Math.max(0, Math.min(-FLOOR_DB, db - FLOOR_DB));
  }

  function updateHolds(peaks, now) {
    for (var i = 0; i < peaks.length; i++) {
      var h = holds[i];
      if (!h || peaks[i] >= h.db || now - h.at > HOLD_MS) holds[i] = { db: peaks[i], at: now };
    }
    holds.length = peaks.length;
  }

  function render() {
    var children = [
      { type: "toggle", label: "Metering", description: "Off stops the engine measuring", action: "toggle", checked: enabled },
    ];

    if (!enabled) {
      children.push({ type: "text", content: "Metering is off." });
    } else if (typeof api.playback.onLevel !== "function") {
      children.push({ type: "text", content: "This host has no api.playback.onLevel." });
    } else if (!level) {
      children.push({
        type: "text",
        content: "No reading. Play something on the native (mpv) engine — paused, stopped, Bit-perfect mode and the browser engine report nothing.",
      });
    } else {
      var count = level.peakDb.length;
      for (var i = 0; i < count; i++) {
        var name = channelName(i, count);
        var peak = level.peakDb[i];
        var rms = level.rmsDb[i];
        var hold = holds[i] ? holds[i].db : peak;
        children.push({ type: "progress-bar", value: toBar(peak), max: -FLOOR_DB, label: name + " peak  " + fmtDb(peak) + "   (hold " + fmtDb(hold) + ")" });
        children.push({ type: "progress-bar", value: toBar(rms), max: -FLOOR_DB, label: name + " RMS  " + fmtDb(rms) });
      }
    }

    children.push({
      type: "text",
      content: readings + " readings" + (lastAt ? " · last " + new Date(lastAt).toLocaleTimeString() : "") + " · bars span " + FLOOR_DB + " dBFS to 0",
    });

    api.ui.setViewData(VIEW_ID, { type: "layout", direction: "vertical", children: children });
  }

  function onReading(next) {
    if (next && next.peakDb && next.peakDb.length) {
      var now = Date.now();
      level = next;
      readings++;
      lastAt = now;
      updateHolds(next.peakDb, now);
    } else {
      level = null;
      holds = [];
    }
    render();
  }

  function subscribe() {
    if (unsubscribe || typeof api.playback.onLevel !== "function") return;
    unsubscribe = api.playback.onLevel(onReading);
  }

  function release() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    level = null;
    holds = [];
  }

  api.ui.onAction("toggle", function () {
    enabled = !enabled;
    if (enabled) subscribe(); else release();
    render();
  });

  subscribe();
  render();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
