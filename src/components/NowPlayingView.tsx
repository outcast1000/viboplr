import { Track } from "../types";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { convertFileSrc } from "@tauri-apps/api/core";

interface NowPlayingViewProps {
  currentTrack: Track;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  volume: number;
  scrobbled: boolean;
  waveformPeaks: number[] | null;
  nextTrack: Track | null;
  albumImagePath: string | null;
  artistImagePath: string | null;
  npArtistBio: { summary: string; listeners: string; playcount: string } | null;
  npAlbumWiki: string | null;
  npAlbumTags: Array<{ name: string }>;
  npSimilarArtists: Array<{ name: string; match: string }>;
  npSimilarTracks: Array<{ name: string; artist: { name: string }; match?: string }>;
  npTrackTags: Array<{ name: string; count?: number }>;
  npArtistTags: Array<{ name: string; count?: number }>;
  libraryTags: Array<{ id: number; name: string }>;
  isVideo: boolean;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (secs: number) => void;
  onVolume: (level: number) => void;
  onMute: () => void;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  onClose: () => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;
}

function formatTime(secs: number): string {
  if (!secs || !isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function NowPlayingView(props: NowPlayingViewProps) {
  const { isVideo } = props;

  if (isVideo) {
    return (
      <div className="np-view np-video">
        {/* Video container is CSS-repositioned from its existing DOM location */}
        {/* FullscreenControls overlay handles all controls */}
      </div>
    );
  }

  return <NowPlayingAudio {...props} />;
}

function NowPlayingAudio(props: NowPlayingViewProps) {
  const {
    currentTrack, playing, positionSecs, durationSecs, volume, scrobbled,
    waveformPeaks, nextTrack, albumImagePath, artistImagePath,
    npArtistBio, npAlbumWiki, npAlbumTags, npSimilarArtists, npSimilarTracks,
    npTrackTags, npArtistTags, libraryTags,
    onPause, onStop, onNext, onPrevious, onSeek, onVolume, onMute,
    onToggleLike, onToggleDislike, onClose,
    onArtistClick, onAlbumClick, onTagClick,
  } = props;

  // Lookup tag ID from name for navigation
  const handleTagClick = (tagName: string) => {
    const tag = libraryTags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
    if (tag) onTagClick(tag.id);
  };

  const albumSrc = albumImagePath ? convertFileSrc(albumImagePath) : null;
  const artistSrc = artistImagePath ? convertFileSrc(artistImagePath) : null;

  return (
    <div className="np-view np-audio">
      <div className="np-body">
        {/* Left side */}
        <div className="np-left">
          <div className="np-hero">
            <div className="np-hero-art">
              {albumSrc ? <img src={albumSrc} alt="" /> : <div className="np-art-placeholder">{"\u266B"}</div>}
            </div>
            <div className="np-hero-info">
              <div className="np-track-title">{currentTrack.title}</div>
              {currentTrack.artist_id && (
                <div className="np-artist-name" onClick={() => onArtistClick(currentTrack.artist_id!)}>
                  {currentTrack.artist_name}
                </div>
              )}
              <div className="np-album-name">
                {currentTrack.album_id ? (
                  <span onClick={() => onAlbumClick(currentTrack.album_id!, currentTrack.artist_id)}>
                    {currentTrack.album_title}
                  </span>
                ) : currentTrack.album_title}
                {currentTrack.year ? ` \u00B7 ${currentTrack.year}` : ""}
              </div>

              {/* Track tags */}
              {npTrackTags.length > 0 && (
                <div className="np-tags">
                  {npTrackTags.slice(0, 8).map((tag) => (
                    <span key={tag.name} className="np-tag" onClick={() => handleTagClick(tag.name)}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Like / Dislike */}
              <div className="np-like-buttons">
                <button
                  className={`np-like-btn ${currentTrack.liked === 1 ? "liked" : ""}`}
                  onClick={onToggleLike}
                  title="Like"
                >{"\u2665"}</button>
                {onToggleDislike && (
                  <button
                    className={`np-like-btn ${currentTrack.liked === -1 ? "disliked" : ""}`}
                    onClick={onToggleDislike}
                    title={currentTrack.liked === -1 ? "Remove dislike" : "Dislike"}
                  >{currentTrack.liked === -1 ? "\u2716" : "\u2298"}</button>
                )}
              </div>

              {/* Up Next */}
              {nextTrack && (
                <div className="np-up-next">
                  <span className="np-up-next-label">Up Next</span>
                  <div className="np-up-next-track">
                    <span className="np-up-next-title">{nextTrack.title}</span>
                    <span className="np-up-next-artist">{nextTrack.artist_name}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Similar tracks */}
          {npSimilarTracks.length > 0 && (
            <div className="np-similar">
              <div className="np-section-title">Similar Tracks</div>
              <div className="np-similar-list">
                {npSimilarTracks.slice(0, 10).map((st, i) => (
                  <div key={i} className="np-similar-row">
                    <span className="np-similar-name">{st.name}</span>
                    <span className="np-similar-artist">{st.artist.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right side — scrollable */}
        <div className="np-right">
          {/* Album card */}
          <div className="np-card">
            <div className="np-card-header">Album</div>
            <div className="np-card-top">
              <div className="np-album-img">
                {albumSrc ? <img src={albumSrc} alt="" /> : <div className="np-img-placeholder">{"\u266B"}</div>}
              </div>
              <div className="np-card-top-info">
                <div className="np-card-name">{currentTrack.album_title || "Unknown Album"}</div>
                <div className="np-card-stats">
                  {currentTrack.year && <span>{currentTrack.year}</span>}
                </div>
              </div>
            </div>
            {npAlbumWiki && (
              <div className="np-card-bio" dangerouslySetInnerHTML={{ __html: npAlbumWiki }} />
            )}
            {npAlbumTags.length > 0 && (
              <div className="np-tags np-card-tags">
                {npAlbumTags.slice(0, 6).map((tag) => (
                  <span key={tag.name} className="np-tag-dim">{tag.name}</span>
                ))}
              </div>
            )}
          </div>

          {/* Artist card */}
          <div className="np-card">
            <div className="np-card-header">Artist</div>
            <div className="np-card-top">
              <div className="np-artist-img">
                {artistSrc ? <img src={artistSrc} alt="" /> : <div className="np-img-placeholder">{"\u266B"}</div>}
              </div>
              <div className="np-card-top-info">
                <div className="np-card-name">{currentTrack.artist_name || "Unknown Artist"}</div>
                {npArtistBio && (
                  <div className="np-card-stats">
                    {npArtistBio.listeners && <span>{Number(npArtistBio.listeners).toLocaleString()} listeners</span>}
                    {npArtistBio.playcount && <span> · {Number(npArtistBio.playcount).toLocaleString()} scrobbles</span>}
                  </div>
                )}
              </div>
            </div>
            {npArtistBio?.summary && (
              <div className="np-card-bio" dangerouslySetInnerHTML={{ __html: npArtistBio.summary }} />
            )}
            {npSimilarArtists.length > 0 && (
              <div className="np-card-similar">
                <span className="np-card-similar-label">Similar: </span>
                {npSimilarArtists.slice(0, 5).map((a, i) => (
                  <span key={a.name}>
                    {i > 0 && ", "}
                    <span className="np-card-link">{a.name}</span>
                  </span>
                ))}
              </div>
            )}
            {npArtistTags.length > 0 && (
              <div className="np-tags np-card-tags">
                {npArtistTags.slice(0, 6).map((tag) => (
                  <span key={tag.name} className="np-tag-dim">{tag.name}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom controls bar */}
      <div className="np-controls">
        <div
          className="now-seek-bar"
          onClick={(e) => {
            if (!durationSecs) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            onSeek(pct * durationSecs);
          }}
        >
          {waveformPeaks ? (
            <WaveformSeekBar
              peaks={waveformPeaks}
              progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
              accentColor="rgba(83, 168, 255, 0.7)"
              dimColor="rgba(255, 255, 255, 0.15)"
            />
          ) : (
            <div className="now-seek-fill" style={{ width: `${durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0}%` }} />
          )}
          <span className="now-seek-time now-seek-elapsed">{formatTime(positionSecs)}</span>
          <span className="now-seek-time now-seek-total">
            {formatTime(durationSecs)}
            {scrobbled && <span className="now-scrobbled" title="Logged to play history">{"\u2713"}</span>}
          </span>
        </div>
        <div className="np-controls-row">
          <div className="np-buttons">
            <button className="ctrl-btn" onClick={onPrevious}>{"\u23EE"}</button>
            <button className="ctrl-btn play-btn" onClick={onPause}>
              {playing ? "\u23F8" : "\u25B6"}
            </button>
            <button className="ctrl-btn" onClick={onNext}>{"\u23ED"}</button>
            <button className="ctrl-btn" onClick={onStop}>{"\u23F9"}</button>
          </div>
          <div className="np-volume">
            <button className="ctrl-btn" onClick={onMute}>{volume === 0 ? "\uD83D\uDD07" : "\uD83D\uDD0A"}</button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
              className="np-volume-slider"
            />
          </div>
          <button className="ctrl-btn np-close-btn" onClick={onClose} title="Restore">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
