import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { parseUrlScheme } from "../queueEntry";
import { store } from "../store";
import {
  QUIZ_MODES,
  buildQuestion,
  fiftyFiftyRemovals,
  formatClock,
  hasEnoughQuizTracks,
  normalizeBestScores,
  type QuizBestScores,
  type QuizMode,
  type QuizQuestion,
} from "../utils/quiz";
import { useAssignRef } from "../hooks/useLatestRef";
import "./MusicQuizView.css";

type Phase = "start" | "loading" | "question" | "locked" | "reveal" | "over";

interface GameResult {
  reason: "timeout" | "quit" | "error";
  score: number;
  newBest: boolean;
}

interface MusicQuizViewProps {
  /** Pause the app's main playback so the mystery snippet plays alone. */
  onPauseMainPlayback: () => void;
  /** Main playback volume (0..1), mirrored to the quiz's own audio element. */
  volume: number;
}

const ANSWER_LETTERS = ["A", "B", "C", "D"];
// Random tracks fetched per game — enough for a long run plus distractor variety.
const QUIZ_POOL_SIZE = 400;
// The clock turns urgent (red pulse) below this.
const LOW_CLOCK_SECS = 15;

/** Resolve a quiz track to something the view's own <audio> element can play. */
async function resolveQuizSrc(track: Track): Promise<string> {
  const parsed = parseUrlScheme(track.path ?? "");
  if (parsed.scheme === "file") return convertFileSrc(parsed.path);
  if (parsed.scheme === "subsonic") {
    return invoke<string>("resolve_subsonic_location", { location: parsed.url });
  }
  throw new Error(`Unsupported quiz source: ${track.path}`);
}

export function MusicQuizView({ onPauseMainPlayback, volume }: MusicQuizViewProps) {
  const [phase, setPhase] = useState<Phase>("start");
  const [mode, setMode] = useState<QuizMode | null>(null);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);
  const [timeDelta, setTimeDelta] = useState<{ value: number; key: number } | null>(null);
  const [bests, setBests] = useState<QuizBestScores>({});
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [eliminated, setEliminated] = useState<number[]>([]);
  const [fiftyUsed, setFiftyUsed] = useState(false);
  const [result, setResult] = useState<GameResult | null>(null);
  const [snippetPlaying, setSnippetPlaying] = useState(false);
  const [snippetProgress, setSnippetProgress] = useState(0);
  // null = still checking the library; false = not enough playable tracks.
  const [canPlay, setCanPlay] = useState<boolean | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const timersRef = useRef<number[]>([]);
  // Bumped on every question load / restart / unmount so stale async work no-ops.
  const genRef = useRef(0);
  const poolRef = useRef<Track[]>([]);
  const usedIdsRef = useRef<Set<number>>(new Set());
  const windowRef = useRef<{ start: number; len: number } | null>(null);
  const retriesRef = useRef(0);
  // Handler-safe mirrors of render state.
  const modeRef = useRef<QuizMode | null>(null);
  const timeLeftRef = useRef(0);
  const scoreRef = useRef(0);
  const bestsRef = useRef<QuizBestScores>({});
  useAssignRef(modeRef, mode);
  useAssignRef(timeLeftRef, timeLeft);
  useAssignRef(scoreRef, score);
  useAssignRef(bestsRef, bests);

  const schedule = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }, []);

  const stopSnippet = useCallback(() => {
    audioRef.current?.pause();
    setSnippetPlaying(false);
  }, []);

  const refreshPool = useCallback(async (): Promise<Track[] | null> => {
    try {
      const results = await invoke<Track[]>("get_tracks", {
        opts: { sortField: "random", sortDir: "asc", limit: QUIZ_POOL_SIZE, offset: 0, mediaType: "audio" },
      });
      poolRef.current = results ?? [];
      setCanPlay(hasEnoughQuizTracks(poolRef.current));
      return poolRef.current;
    } catch (e) {
      console.error("Failed to load quiz track pool:", e);
      setCanPlay(false);
      return null;
    }
  }, []);

  useEffect(() => { void refreshPool(); }, [refreshPool]);

  useEffect(() => {
    store.get<unknown>("quizBestScores")
      .then((raw) => setBests(normalizeBestScores(raw)))
      .catch((e) => console.error("Failed to load quiz best scores:", e));
  }, []);

  // Stop everything when the user navigates away from the view.
  useEffect(() => {
    return () => {
      clearTimers();
      genRef.current++;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
    };
  }, [clearTimers]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = Math.min(1, Math.max(0, volume));
  }, [volume, phase]);

  const finishGame = useCallback((reason: GameResult["reason"]) => {
    stopSnippet();
    clearTimers();
    const currentMode = modeRef.current;
    const finalScore = scoreRef.current;
    let newBest = false;
    if (currentMode && finalScore > (bestsRef.current[currentMode.id] ?? 0)) {
      newBest = true;
      const updated = { ...bestsRef.current, [currentMode.id]: finalScore };
      setBests(updated);
      store.set("quizBestScores", updated)
        .catch((e) => console.error("Failed to save quiz best scores:", e));
    }
    setResult({ reason, score: finalScore, newBest });
    setPhase("over");
  }, [stopSnippet, clearTimers]);

  // The game clock: drains in real time while a question is live (listening
  // AND thinking). It pauses during load, lock-in suspense, and reveal.
  useEffect(() => {
    if (phase !== "question") return;
    let last = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      setTimeLeft((t) => t - dt);
    }, 200);
    return () => window.clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (phase === "question" && timeLeft <= 0) finishGame("timeout");
  }, [phase, timeLeft, finishGame]);

  const loadQuestion = useCallback(async () => {
    const currentMode = modeRef.current;
    if (!currentMode) return;
    const gen = ++genRef.current;
    setPhase("loading");
    setSelected(null);
    setEliminated([]);
    setSnippetProgress(0);
    setSnippetPlaying(false);

    const q = buildQuestion(poolRef.current, currentMode, usedIdsRef.current, Math.random);
    if (!q) {
      // Pool went dry mid-game — end the run with what's scored.
      finishGame("error");
      return;
    }
    usedIdsRef.current.add(q.correct.id!);

    try {
      const src = await resolveQuizSrc(q.correct);
      if (gen !== genRef.current) return;
      windowRef.current = { start: q.snippetStart, len: q.snippetLen };
      setQuestion(q);
      setPhase("question");
      onPauseMainPlayback();
      const audio = audioRef.current;
      if (audio) {
        audio.src = src;
        audio.load();
      }
    } catch (e) {
      console.error("Failed to resolve quiz snippet source:", e);
      if (gen !== genRef.current) return;
      if (retriesRef.current < 3) {
        retriesRef.current++;
        void loadQuestion();
      } else {
        finishGame("error");
      }
    }
  }, [finishGame, onPauseMainPlayback]);

  const startGame = useCallback(async (nextMode: QuizMode) => {
    clearTimers();
    const gen = ++genRef.current;
    setMode(nextMode);
    modeRef.current = nextMode;
    setPhase("loading");
    setScore(0);
    setTimeLeft(nextMode.startSecs);
    setTimeDelta(null);
    setFiftyUsed(false);
    setResult(null);
    usedIdsRef.current = new Set();
    retriesRef.current = 0;
    // Fresh random pool per game so questions don't repeat between runs.
    const pool = await refreshPool();
    if (gen !== genRef.current) return;
    if (!pool || !hasEnoughQuizTracks(pool)) {
      setPhase("start");
      return;
    }
    void loadQuestion();
  }, [clearTimers, refreshPool, loadQuestion]);

  // --- audio element events -------------------------------------------------

  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    const win = windowRef.current;
    if (!audio || !win) return;
    // The DB's duration tag can overstate the real file length (bad metadata,
    // truncated files) — seeking past the end errors and would burn a retry.
    // Clamp the window to what the decoder actually reports.
    const realDuration = Number.isFinite(audio.duration) ? audio.duration : null;
    let effectiveWin = win;
    if (realDuration !== null && win.start >= realDuration) {
      effectiveWin = { start: 0, len: Math.min(win.len, realDuration || win.len) };
      windowRef.current = effectiveWin;
    }
    audio.currentTime = effectiveWin.start;
    audio.play()
      .then(() => {
        retriesRef.current = 0;
        setSnippetPlaying(true);
      })
      .catch((e) => console.error("Failed to start quiz snippet:", e));
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    const win = windowRef.current;
    if (!audio || !win) return;
    const elapsed = audio.currentTime - win.start;
    setSnippetProgress(Math.min(1, Math.max(0, elapsed / win.len)));
    if (elapsed >= win.len) {
      audio.pause();
      setSnippetPlaying(false);
      setSnippetProgress(1);
    }
  }, []);

  // Very short tracks can hit EOF before the timeupdate cutoff fires.
  const handleEnded = useCallback(() => {
    setSnippetPlaying(false);
    setSnippetProgress(1);
  }, []);

  const handleAudioError = useCallback(() => {
    console.error("Quiz snippet failed to load/decode; swapping question");
    if (phase !== "question" && phase !== "loading") return;
    if (retriesRef.current < 3) {
      retriesRef.current++;
      void loadQuestion();
    } else {
      finishGame("error");
    }
  }, [phase, loadQuestion, finishGame]);

  // --- game actions ---------------------------------------------------------

  const selectAnswer = useCallback((index: number) => {
    const currentMode = modeRef.current;
    if (phase !== "question" || !question || !currentMode || eliminated.includes(index)) return;
    stopSnippet();
    setSelected(index);
    setPhase("locked");
    const correct = index === question.correctIndex;
    // A short suspense beat: lock in, hold, then reveal with the time delta.
    schedule(() => {
      setPhase("reveal");
      const delta = correct ? currentMode.bonusSecs : -currentMode.penaltySecs;
      setTimeLeft((t) => t + delta);
      setTimeDelta({ value: delta, key: performance.now() });
      if (correct) setScore((s) => s + 1);
      schedule(() => {
        if (timeLeftRef.current <= 0) finishGame("timeout");
        else void loadQuestion();
      }, correct ? 1300 : 1900);
    }, 1200);
  }, [phase, question, eliminated, stopSnippet, schedule, finishGame, loadQuestion]);

  const useFiftyFifty = useCallback(() => {
    if (fiftyUsed || phase !== "question" || !question) return;
    setEliminated(fiftyFiftyRemovals(question.options.length, question.correctIndex, Math.random));
    setFiftyUsed(true);
  }, [fiftyUsed, phase, question]);

  const replaySnippet = useCallback(() => {
    if (phase !== "question") return;
    const audio = audioRef.current;
    const win = windowRef.current;
    if (!audio || !win) return;
    audio.currentTime = win.start;
    setSnippetProgress(0);
    audio.play()
      .then(() => setSnippetPlaying(true))
      .catch((e) => console.error("Failed to replay quiz snippet:", e));
  }, [phase]);

  const skipQuestion = useCallback(() => {
    const currentMode = modeRef.current;
    if (phase !== "question" || !currentMode) return;
    stopSnippet();
    const next = timeLeftRef.current - currentMode.skipSecs;
    setTimeLeft(next);
    setTimeDelta({ value: -currentMode.skipSecs, key: performance.now() });
    if (next <= 0) finishGame("timeout");
    else void loadQuestion();
  }, [phase, stopSnippet, finishGame, loadQuestion]);

  const endRun = useCallback(() => {
    if (phase !== "question") return;
    finishGame("quit");
  }, [phase, finishGame]);

  // --- render ---------------------------------------------------------------

  const inRound = phase === "question" || phase === "locked" || phase === "reveal" || phase === "loading";

  const answerClass = (index: number): string => {
    const classes = ["quiz-answer", "quiz-lozenge"];
    if (question) {
      const revealed = phase === "reveal";
      if (revealed && index === question.correctIndex) classes.push("correct");
      else if (revealed && index === selected) classes.push("wrong");
      else if (index === selected && phase === "locked") classes.push("selected");
    }
    if (eliminated.includes(index)) classes.push("eliminated");
    return classes.join(" ");
  };

  const playerCaption = phase === "loading"
    ? "Cueing up a mystery track…"
    : snippetPlaying
      ? "Listen carefully — the clock is running…"
      : "Name that song — replay is free, the clock isn't";

  const resultTitle = result?.reason === "timeout"
    ? "Time's up!"
    : result?.reason === "quit"
      ? "Run ended"
      : "Something went off-key";

  return (
    <div className="music-quiz">
      <div className="quiz-stage">
        {phase === "start" && (
          <div className="quiz-splash">
            <div className="quiz-logo">
              <svg width="72" height="72" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <h1>Song Quiz</h1>
            <p>
              Beat the clock: a few seconds from a random track, four titles, one is right.
              Correct answers add time, wrong ones cost it. How many can you name before 0:00?
            </p>
            {canPlay === null && <p>Checking your library…</p>}
            {canPlay === false && (
              <p>Not enough playable tracks yet — the quiz needs at least four local or Subsonic songs with different titles.</p>
            )}
            <div className="quiz-modes">
              {QUIZ_MODES.map((m) => (
                <button
                  key={m.id}
                  className="quiz-mode-card"
                  onClick={() => { void startGame(m); }}
                  disabled={canPlay !== true}
                >
                  <span className="quiz-mode-name">{m.label}</span>
                  <span className="quiz-mode-stat">{formatClock(m.startSecs)} on the clock</span>
                  <span className="quiz-mode-stat">+{m.bonusSecs}s right · −{m.penaltySecs}s wrong</span>
                  <span className="quiz-mode-stat">
                    {m.snippetSecs}s snippets{m.sameArtistDistractors ? " · same-artist answers" : ""}
                  </span>
                  <span className="quiz-mode-best">Best: {bests[m.id] ?? "—"}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {phase === "over" && result && (
          <div className="quiz-splash">
            <div className="quiz-result-score">
              {result.score}
              <span className="quiz-result-score-label">{result.score === 1 ? "song" : "songs"} named</span>
            </div>
            <h1>{resultTitle}</h1>
            {result.newBest ? (
              <p className="quiz-new-best">New {mode?.label} best!</p>
            ) : (
              mode && <p className="quiz-result-answer">Best on {mode.label}: <strong>{bests[mode.id] ?? 0}</strong></p>
            )}
            {result.reason === "error" && (
              <p>Too many snippets failed to play. Check that your files are reachable and try again.</p>
            )}
            {question && result.reason !== "quit" && (
              <p className="quiz-result-answer">
                The last one was <strong>{question.correct.title}</strong>
                {question.correct.artist_name ? <> by <strong>{question.correct.artist_name}</strong></> : null}
              </p>
            )}
            <div className="quiz-over-actions">
              {mode && (
                <button className="ds-btn ds-btn--primary ds-btn--lg" onClick={() => { void startGame(mode); }}>
                  Play again
                </button>
              )}
              <button className="ds-btn ds-btn--secondary ds-btn--lg" onClick={() => { setResult(null); setPhase("start"); }}>
                Change mode
              </button>
            </div>
          </div>
        )}

        {inRound && mode && (
          <>
            <div className="quiz-hud">
              <div className="quiz-hud-left">
                <span className="quiz-mode-chip">{mode.label}</span>
                <span className="quiz-hud-stat">Score <strong>{score}</strong></span>
                <span className="quiz-hud-stat">Best <strong>{bests[mode.id] ?? 0}</strong></span>
              </div>
              <div className="quiz-hud-right">
                <span className={`quiz-clock${timeLeft <= LOW_CLOCK_SECS ? " low" : ""}`}>
                  {formatClock(timeLeft)}
                  {timeDelta && (
                    <span
                      key={timeDelta.key}
                      className={`quiz-time-delta ${timeDelta.value > 0 ? "gain" : "loss"}`}
                    >
                      {timeDelta.value > 0 ? "+" : "−"}{Math.abs(timeDelta.value)}s
                    </span>
                  )}
                </span>
                <button
                  className="ds-btn ds-btn--ghost ds-btn--sm"
                  onClick={endRun}
                  disabled={phase !== "question"}
                >
                  End run
                </button>
              </div>
            </div>

            <div className="quiz-topbar">
              <button
                className={`quiz-lifeline${fiftyUsed ? " spent" : ""}`}
                onClick={useFiftyFifty}
                disabled={fiftyUsed || phase !== "question"}
                title="Remove two wrong answers (once per run)"
              >
                50:50
              </button>
              <button
                className="quiz-lifeline"
                onClick={replaySnippet}
                disabled={phase !== "question"}
                title="Hear the snippet again — free, but the clock keeps running"
              >
                ↻
              </button>
              <button
                className="quiz-lifeline quiz-lifeline--wide"
                onClick={skipQuestion}
                disabled={phase !== "question"}
                title="Skip this song for a small time penalty"
              >
                Skip −{mode.skipSecs}s
              </button>
            </div>

            <div className="quiz-player">
              <div className={`quiz-eq ${snippetPlaying ? "playing" : ""}`}>
                {Array.from({ length: 7 }, (_, i) => <span key={i} />)}
              </div>
              <div className="quiz-snippet-progress">
                <div style={{ width: `${Math.round(snippetProgress * 100)}%` }} />
              </div>
              <div className="quiz-player-caption">{playerCaption}</div>
            </div>

            <div className="quiz-wire-row">
              <div className="quiz-lozenge quiz-question-lozenge">
                <div className="quiz-lozenge-inner">Which song is this?</div>
              </div>
            </div>

            <div className="quiz-answers">
              {(question?.options ?? []).map((track, i) => (
                <div className="quiz-wire-row" key={track.key}>
                  <button
                    className={answerClass(i)}
                    onClick={() => selectAnswer(i)}
                    disabled={phase !== "question" || eliminated.includes(i)}
                    title={track.artist_name ? `${track.title} — ${track.artist_name}` : track.title}
                  >
                    <div className="quiz-lozenge-inner">
                      <span className="quiz-answer-letter">{ANSWER_LETTERS[i]}:</span>
                      <span className="quiz-answer-text">
                        {track.title}
                        {track.artist_name && <span className="quiz-answer-artist"> — {track.artist_name}</span>}
                      </span>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <audio
        ref={audioRef}
        preload="auto"
        style={{ display: "none" }}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        onError={handleAudioError}
      />
    </div>
  );
}
