import { useState } from "react";
import { Track } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import LyricsPanel from "./LyricsPanel";

interface NowPlayingViewProps {
  currentTrack: Track;
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
  npLyrics: { text: string; kind: string; provider: string } | null;
  npLyricsLoading: boolean;
  positionSecs: number;
  onSaveLyrics: (text: string, kind: string) => void;
  onResetLyrics: () => void;
  onForceRefreshLyrics: () => void;
  isVideo: boolean;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;
  onSimilarTrackFound: (track: Track) => void;
  addLog: (message: string) => void;
}

export default function NowPlayingView(props: NowPlayingViewProps) {
  const { isVideo } = props;

  if (isVideo) {
    return <div className="np-view np-video" />;
  }

  return <NowPlayingBody {...props} />;
}

function SimilarTracksLine({ tracks, onFound, addLog }: {
  tracks: Array<{ name: string; artist: { name: string }; match?: string }>;
  onFound: (track: Track) => void;
  addLog: (message: string) => void;
}) {
  const [searching, setSearching] = useState<number | null>(null);

  const handleClick = async (st: { name: string; artist: { name: string } }, index: number) => {
    if (searching !== null) return;
    setSearching(index);
    try {
      const results = await invoke<Track[]>("get_tracks", {
        opts: { query: st.name, limit: 50 },
      });
      const match = results.find(
        (t) =>
          t.title.toLowerCase() === st.name.toLowerCase() &&
          (t.artist_name ?? "").toLowerCase() === st.artist.name.toLowerCase()
      );
      if (match) {
        onFound(match);
      } else {
        addLog(`"${st.name}" by ${st.artist.name} is not in your library`);
      }
    } catch {
      addLog(`Could not search for "${st.name}"`);
    } finally {
      setSearching(null);
    }
  };

  return (
    <div className="np-similar-inline">
      <span className="np-similar-inline-label">Similar: </span>
      {tracks.slice(0, 8).map((st, i) => (
        <span key={i}>
          {i > 0 && ", "}
          <span
            className={`np-card-link${searching === i ? " np-similar-searching" : ""}`}
            onClick={() => handleClick(st, i)}
            title={`${st.name} — ${st.artist.name}`}
          >
            {st.name}
          </span>
        </span>
      ))}
    </div>
  );
}

function NowPlayingBody(props: NowPlayingViewProps) {
  const {
    currentTrack, nextTrack, albumImagePath, artistImagePath,
    npArtistBio, npAlbumWiki, npAlbumTags, npSimilarArtists, npSimilarTracks,
    npTrackTags, npArtistTags, libraryTags,
    npLyrics, npLyricsLoading, positionSecs,
    onSaveLyrics, onResetLyrics, onForceRefreshLyrics,
    onToggleLike, onToggleDislike, onArtistClick, onAlbumClick, onTagClick,
    onSimilarTrackFound, addLog,
  } = props;

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

              {npTrackTags.length > 0 && (
                <div className="np-tags">
                  {npTrackTags.slice(0, 8).map((tag) => (
                    <span key={tag.name} className="np-tag" onClick={() => handleTagClick(tag.name)}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}

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

          {npSimilarTracks.length > 0 && (
            <SimilarTracksLine
              tracks={npSimilarTracks}
              onFound={onSimilarTrackFound}
              addLog={addLog}
            />
          )}

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

        {/* Right side -- lyrics */}
        <div className="np-right">
          <LyricsPanel
            trackId={currentTrack.id}
            positionSecs={positionSecs}
            lyrics={npLyrics}
            loading={npLyricsLoading}
            onSave={onSaveLyrics}
            onReset={onResetLyrics}
            onForceRefresh={onForceRefreshLyrics}
          />
        </div>
      </div>
    </div>
  );
}
