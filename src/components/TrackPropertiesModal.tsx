import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track, Tag, Collection } from "../types";
import { formatDuration } from "../utils";
import "./TrackPropertiesModal.css";

interface SimilarActions {
  isLocal: (artist: string, title: string) => boolean;
  onPlay: (artist: string, title: string) => void;
  onSearchTidal?: (title: string, artist: string) => void;
  onWatchYoutube: (artist: string, title: string) => void;
}

interface TrackPropertiesModalProps {
  track: Track;
  collections: Collection[];
  onClose: () => void;
  onYoutubeUrlChange: (trackId: number, url: string | null) => void;
  similarActions?: SimilarActions;
}

interface AudioProperties {
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  bitrate: number | null;
}

type PropertiesTab = "main" | "tags" | "format" | "similar" | "info" | "other";

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

interface SimilarTrack {
  name: string;
  artist: { name: string };
  match: string;
  url: string;
}

interface LastfmTag {
  name: string;
  count: number;
}

interface ArtistInfo {
  bio?: { summary?: string; content?: string };
  stats?: { listeners?: string; playcount?: string };
  tags?: { tag?: Array<{ name: string }> };
}

export function TrackPropertiesModal({ track, collections, onClose, onYoutubeUrlChange, similarActions }: TrackPropertiesModalProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [audioProps, setAudioProps] = useState<AudioProperties | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState(track.youtube_url ?? "");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<PropertiesTab>("main");
  const [copied, setCopied] = useState(false);

  // Community tags state
  const [suggestedTags, setSuggestedTags] = useState<LastfmTag[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [applyingTags, setApplyingTags] = useState(false);

  // Similar tracks state
  const [similarTracks, setSimilarTracks] = useState<SimilarTrack[]>([]);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const [similarLoaded, setSimilarLoaded] = useState(false);

  // Artist info state
  const [artistInfo, setArtistInfo] = useState<ArtistInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoLoaded, setInfoLoaded] = useState(false);

  useEffect(() => {
    invoke<Tag[]>("get_tags_for_track", { trackId: track.id }).then(setTags);
    invoke<AudioProperties>("get_track_audio_properties", { trackId: track.id })
      .then(setAudioProps)
      .catch(() => setAudioProps({ sample_rate: null, bit_depth: null, channels: null, bitrate: null }));
  }, [track.id]);

  // Fetch similar tracks when tab is opened
  useEffect(() => {
    if (tab !== "similar" || similarLoaded || !track.artist_name) return;
    setLoadingSimilar(true);

    const parseSimilar = (resp: { similartracks?: { track?: SimilarTrack[] } } | null) => {
      setSimilarTracks(resp?.similartracks?.track ?? []);
      setLoadingSimilar(false);
      setSimilarLoaded(true);
    };

    invoke<any>("lastfm_get_similar_tracks", { artistName: track.artist_name, trackTitle: track.title })
      .then(resp => { if (resp) parseSimilar(resp); })
      .catch(() => parseSimilar(null));

    const unlisten = listen<any>("lastfm-similar-tracks", (event) => parseSimilar(event.payload));
    return () => { unlisten.then(f => f()); };
  }, [tab, similarLoaded, track.artist_name, track.title]);

  // Fetch artist info when tab is opened
  useEffect(() => {
    if (tab !== "info" || infoLoaded || !track.artist_name) return;
    setLoadingInfo(true);

    const parseInfo = (resp: { artist?: ArtistInfo } | null) => {
      setArtistInfo(resp?.artist ?? null);
      setLoadingInfo(false);
      setInfoLoaded(true);
    };

    invoke<any>("lastfm_get_artist_info", { artistName: track.artist_name })
      .then(resp => { if (resp) parseInfo(resp); })
      .catch(() => parseInfo(null));

    const unlisten = listen<any>("lastfm-artist-info", (event) => parseInfo(event.payload));
    return () => { unlisten.then(f => f()); };
  }, [tab, infoLoaded, track.artist_name]);

  async function fetchSuggestedTags() {
    if (!track.artist_name) return;
    setLoadingSuggestions(true);

    const applyTags = (resp: { toptags?: { tag?: Array<{ name: string; count: number }> } } | null) => {
      const existing = new Set(tags.map(t => t.name.toLowerCase()));
      const filtered = (resp?.toptags?.tag ?? []).filter(t => !existing.has(t.name.toLowerCase()));
      setSuggestedTags(filtered);
      setSelectedSuggestions(new Set());
      setLoadingSuggestions(false);
    };

    // Listen for async result before invoking (in case of cache miss)
    const unlisten = await listen<any>("lastfm-track-tags", (event) => {
      applyTags(event.payload);
      unlisten();
    });

    try {
      const resp = await invoke<any>("lastfm_get_track_tags", { artistName: track.artist_name, trackTitle: track.title });
      if (resp) {
        applyTags(resp);
        unlisten(); // cached hit, no need to listen
      }
    } catch {
      applyTags(null);
      unlisten();
    }
  }

  async function applySuggestedTags() {
    if (selectedSuggestions.size === 0) return;
    setApplyingTags(true);
    try {
      const applied = await invoke<Array<[number, string]>>(
        "lastfm_apply_community_tags", { trackId: track.id, tagNames: [...selectedSuggestions] }
      );
      const newTags: Tag[] = applied.map(([id, name]) => ({ id, name, liked: 0, track_count: 0 }));
      setTags(prev => [...prev, ...newTags.filter(nt => !prev.some(t => t.id === nt.id))]);
      setSuggestedTags(prev => prev.filter(t => !selectedSuggestions.has(t.name)));
      setSelectedSuggestions(new Set());
    } catch (e) {
      console.error("Failed to apply tags:", e);
    } finally {
      setApplyingTags(false);
    }
  }

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

  const tabLabels: Record<PropertiesTab, string> = {
    main: "General",
    tags: "Tags",
    format: "Format",
    similar: "Similar",
    info: "Info",
    other: "Other",
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-properties" onClick={(e) => e.stopPropagation()}>
        <div className="properties-caption">
          <div className="properties-caption-text">
            <h2>{track.title}</h2>
            <div className="properties-subtitle">{track.artist_name ?? "Unknown"}{track.album_title ? ` — ${track.album_title}` : ""}</div>
          </div>
          <button className="properties-caption-close" onClick={onClose}>&times;</button>
        </div>

        <div className="properties-body">
          <div className="properties-tabs">
            {(["main", "tags", "format", "similar", "info", "other"] as PropertiesTab[]).map(t => (
              <button
                key={t}
                className={`properties-tab${tab === t ? " active" : ""}`}
                onClick={() => { setTab(t); setCopied(false); }}
              >
                {tabLabels[t]}
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
              <div className="properties-tags-section" style={{ marginTop: 12 }}>
                {suggestedTags.length === 0 ? (
                  <button
                    className="modal-btn modal-btn-cancel"
                    onClick={fetchSuggestedTags}
                    disabled={loadingSuggestions || !track.artist_name}
                    style={{ fontSize: 12 }}
                  >
                    {loadingSuggestions ? "Loading..." : "Suggest tags from Last.fm"}
                  </button>
                ) : (
                  <>
                    <label>Last.fm suggestions</label>
                    <div className="properties-tags" style={{ marginTop: 4 }}>
                      {suggestedTags.map(t => (
                        <span
                          key={t.name}
                          className={`properties-tag properties-tag-suggestion${selectedSuggestions.has(t.name) ? " selected" : ""}`}
                          style={{ cursor: "pointer", opacity: selectedSuggestions.has(t.name) ? 1 : 0.7 }}
                          onClick={() => setSelectedSuggestions(prev => {
                            const next = new Set(prev);
                            if (next.has(t.name)) next.delete(t.name); else next.add(t.name);
                            return next;
                          })}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                    {selectedSuggestions.size > 0 && (
                      <button
                        className="modal-btn modal-btn-confirm"
                        onClick={applySuggestedTags}
                        disabled={applyingTags}
                        style={{ marginTop: 8, fontSize: 12 }}
                      >
                        {applyingTags ? "Applying..." : `Apply ${selectedSuggestions.size} tag${selectedSuggestions.size > 1 ? "s" : ""}`}
                      </button>
                    )}
                  </>
                )}
              </div>
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

          {tab === "similar" && (
            <div className="properties-similar">
              {loadingSimilar && <div style={{ padding: 12, opacity: 0.6 }}>Loading similar tracks...</div>}
              {similarLoaded && similarTracks.length === 0 && !loadingSimilar && (
                <div style={{ padding: 12, opacity: 0.6 }}>No similar tracks found.</div>
              )}
              {similarTracks.length > 0 && (
                <div className="properties-similar-list">
                  {similarTracks.map((st, i) => {
                    const isLocal = similarActions?.isLocal(st.artist.name, st.name);
                    return (
                      <div key={i} className="properties-similar-item">
                        <span className="properties-similar-match">{Math.round(parseFloat(st.match) * 100)}%</span>
                        <span className="properties-similar-info">
                          <span className="properties-similar-title">{st.name}</span>
                          <span className="properties-similar-artist">{st.artist.name}</span>
                        </span>
                        <span className="properties-similar-actions">
                          {isLocal && similarActions && (
                            <button
                              className="properties-similar-action"
                              title="Play"
                              onClick={() => { similarActions.onPlay(st.artist.name, st.name); onClose(); }}
                            >&#9654;</button>
                          )}
                          {similarActions?.onSearchTidal && (
                            <button
                              className="properties-similar-action"
                              title="Search in TIDAL"
                              onClick={() => { similarActions.onSearchTidal!(st.name, st.artist.name); onClose(); }}
                            >
                              <svg width="14" height="14" viewBox="0 0 40 40" fill="currentColor"><path d="M0 13.3h13.3V0H0zm13.3 13.4h13.4V13.3H13.3zM0 26.7h13.3V13.3H0zm26.7 0H40V13.3H26.7zM13.3 40h13.4V26.7H13.3z"/></svg>
                            </button>
                          )}
                          {similarActions && (
                            <button
                              className="properties-similar-action"
                              title="Watch on YouTube"
                              onClick={() => { similarActions.onWatchYoutube(st.artist.name, st.name); }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 00-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 00.5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 002.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 002.1-2.1c.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.5 15.6V8.4l6.3 3.6-6.3 3.6z"/></svg>
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "info" && (
            <div className="properties-info">
              {loadingInfo && <div style={{ padding: 12, opacity: 0.6 }}>Loading artist info...</div>}
              {infoLoaded && !artistInfo && !loadingInfo && (
                <div style={{ padding: 12, opacity: 0.6 }}>No info available.</div>
              )}
              {artistInfo && (
                <>
                  {(artistInfo.stats?.listeners || artistInfo.stats?.playcount) && (
                    <div className="properties-grid" style={{ marginBottom: 12 }}>
                      {artistInfo.stats?.listeners && (
                        <div className="properties-grid-item">
                          <label>Listeners</label>
                          <span>{parseInt(artistInfo.stats.listeners).toLocaleString()}</span>
                        </div>
                      )}
                      {artistInfo.stats?.playcount && (
                        <div className="properties-grid-item">
                          <label>Scrobbles</label>
                          <span>{parseInt(artistInfo.stats.playcount).toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {artistInfo.tags?.tag && artistInfo.tags.tag.length > 0 && (
                    <div className="properties-tags-section" style={{ marginBottom: 12 }}>
                      <label>Top Tags</label>
                      <div className="properties-tags">
                        {artistInfo.tags.tag.map(t => (
                          <span key={t.name} className="properties-tag">{t.name}</span>
                        ))}
                      </div>
                      <button
                        className="modal-btn modal-btn-confirm"
                        onClick={async () => {
                          const tagNames = artistInfo.tags!.tag!.map(t => t.name);
                          try {
                            const result = await invoke<Array<[number, string]>>("replace_track_tags", { trackId: track.id, tagNames });
                            setTags(result.map(([id, name]) => ({ id, name, liked: 0, track_count: 0 })));
                          } catch (e) {
                            console.error("Failed to replace tags:", e);
                          }
                        }}
                        style={{ marginTop: 8, fontSize: 12 }}
                      >
                        Apply as track tags
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "other" && (
            <>
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
        </div>
      </div>
    </div>
  );
}
