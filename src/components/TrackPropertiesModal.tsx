import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Tag, Collection } from "../types";
import { formatDuration } from "../utils";

interface TrackPropertiesModalProps {
  track: Track;
  collections: Collection[];
  onClose: () => void;
  onYoutubeUrlChange: (trackId: number, url: string | null) => void;
}

interface AudioProperties {
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  bitrate: number | null;
}

type PropertiesTab = "main" | "tags" | "format" | "other";

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSampleRate(hz: number | null): string {
  if (!hz) return "—";
  return `${(hz / 1000).toFixed(1)} kHz`;
}

export function TrackPropertiesModal({ track, collections, onClose, onYoutubeUrlChange }: TrackPropertiesModalProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [audioProps, setAudioProps] = useState<AudioProperties | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState(track.youtube_url ?? "");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<PropertiesTab>("main");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<Tag[]>("get_tags_for_track", { trackId: track.id }).then(setTags);
    invoke<AudioProperties>("get_track_audio_properties", { trackId: track.id })
      .then(setAudioProps)
      .catch(() => setAudioProps({ sample_rate: null, bit_depth: null, channels: null, bitrate: null }));
  }, [track.id]);

  const dirty = (youtubeUrl.trim() || null) !== (track.youtube_url ?? null);

  async function handleApply() {
    const trimmed = youtubeUrl.trim();
    setSaving(true);
    try {
      if (trimmed) {
        await invoke("set_track_youtube_url", { trackId: track.id, url: trimmed });
        onYoutubeUrlChange(track.id, trimmed);
      } else {
        await invoke("clear_track_youtube_url", { trackId: track.id });
        onYoutubeUrlChange(track.id, null);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-properties" onClick={(e) => e.stopPropagation()}>
        <h2>{track.title}</h2>
        <div className="properties-subtitle">{track.artist_name ?? "Unknown"}{track.album_title ? ` — ${track.album_title}` : ""}</div>

        <div className="properties-tabs">
          {(["main", "tags", "format", "other"] as PropertiesTab[]).map(t => (
            <button
              key={t}
              className={`properties-tab${tab === t ? " active" : ""}`}
              onClick={() => { setTab(t); setCopied(false); }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="properties-tab-content">
          {tab === "main" && (
            <div className="properties-main">
              <div className="properties-main-field">
                <label>{track.subsonic_id ? "Source" : "File Path"}</label>
                <div className="properties-main-path">{track.subsonic_id
                  ? `${(collections.find(c => c.id === track.collection_id)?.url ?? "").replace(/\/+$/, "")}/rest/stream.view?id=${track.subsonic_id}`
                  : track.path}</div>
              </div>
              <div className="properties-main-actions">
                <button
                  className="modal-btn modal-btn-cancel"
                  onClick={() => {
                    const text = track.subsonic_id
                      ? `${(collections.find(c => c.id === track.collection_id)?.url ?? "").replace(/\/+$/, "")}/rest/stream.view?id=${track.subsonic_id}`
                      : track.path;
                    navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied!" : "Copy Path"}
                </button>
                {!track.subsonic_id && (
                  <button
                    className="modal-btn modal-btn-cancel"
                    onClick={() => invoke("show_in_folder", { trackId: track.id })}
                  >
                    Locate File
                  </button>
                )}
              </div>
            </div>
          )}

          {tab === "tags" && (
            <>
              <div className="properties-grid">
                <div className="properties-grid-item properties-grid-span">
                  <label>Title</label>
                  <span>{track.title}</span>
                </div>
                <div className="properties-grid-item">
                  <label>Artist</label>
                  <span>{track.artist_name ?? "Unknown"}</span>
                </div>
                <div className="properties-grid-item">
                  <label>Album</label>
                  <span>{track.album_title ?? "Unknown"}</span>
                </div>
                {track.year && (
                  <div className="properties-grid-item">
                    <label>Year</label>
                    <span>{track.year}</span>
                  </div>
                )}
                {track.track_number && (
                  <div className="properties-grid-item">
                    <label>Track #</label>
                    <span>{track.track_number}</span>
                  </div>
                )}
              </div>
              {tags.length > 0 && (
                <div className="properties-tags-section">
                  <label>Tags</label>
                  <div className="properties-tags">
                    {tags.map(t => (
                      <span key={t.id} className="properties-tag">{t.name}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "format" && (
            <div className="properties-grid">
              <div className="properties-grid-item">
                <label>Duration</label>
                <span>{formatDuration(track.duration_secs)}</span>
              </div>
              <div className="properties-grid-item">
                <label>Format</label>
                <span>{track.format?.toUpperCase() ?? "—"}</span>
              </div>
              <div className="properties-grid-item">
                <label>File Size</label>
                <span>{formatFileSize(track.file_size)}</span>
              </div>
              <div className="properties-grid-item">
                <label>Bitrate</label>
                <span>{audioProps?.bitrate ? `${audioProps.bitrate} kbps` : "—"}</span>
              </div>
              <div className="properties-grid-item">
                <label>Sample Rate</label>
                <span>{formatSampleRate(audioProps?.sample_rate ?? null)}</span>
              </div>
              <div className="properties-grid-item">
                <label>Bit Depth</label>
                <span>{audioProps?.bit_depth ? `${audioProps.bit_depth}-bit` : "—"}</span>
              </div>
              <div className="properties-grid-item">
                <label>Channels</label>
                <span>{audioProps?.channels ?? "—"}</span>
              </div>
            </div>
          )}

          {tab === "other" && (
            <>
              <div className="modal-field">
                <label>{track.subsonic_id ? "Source" : "File Path"}</label>
                <div className="modal-field-static modal-field-path" title={track.path}>
                  {track.subsonic_id
                    ? `${(collections.find(c => c.id === track.collection_id)?.url ?? "").replace(/\/+$/, "")}/rest/stream.view?id=${track.subsonic_id}`
                    : track.path}
                </div>
              </div>

              <div className="modal-field">
                <label>YouTube URL</label>
                <div className="properties-youtube-row">
                  <input
                    type="text"
                    value={youtubeUrl}
                    placeholder="https://www.youtube.com/watch?v=..."
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && dirty && handleApply()}
                  />
                  <button
                    className="modal-btn modal-btn-confirm properties-apply-btn"
                    onClick={handleApply}
                    disabled={!dirty || saving}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
