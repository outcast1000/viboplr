import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EngineSource, Track } from "../types";
import { parseUrlScheme } from "../queueEntry";
import { store } from "../store";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import type {
  EngineDurationEvent,
  EngineEndedEvent,
  EngineErrorEvent,
  EnginePositionEvent,
} from "../playback/nativeEngine";
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
  /** Play a snippet through the engine (usePlayback's clip API — it hands the
   *  main player's place back afterwards). `key` is what the clip's `engine-*`
   *  events carry; `onLost` runs when a main play or Stop takes the engine. */
  playClip: (
    source: EngineSource,
    seekSecs?: number,
    opts?: { onLost?: () => void },
  ) => { key: string; started: Promise<void> };
  seekClip: (key: string, secs: number) => void;
  stopClip: (key: string) => void;
}

const ANSWER_LETTERS = ["A", "B", "C", "D"];
// Random tracks fetched per game — enough for a long run plus distractor variety.
const QUIZ_POOL_SIZE = 400;
// The clock turns urgent (red pulse) below this.
const LOW_CLOCK_SECS = 15;

/** Resolve a quiz track to something the engine can open. */
async function resolveQuizSource(track: Track): Promise<EngineSource> {
  const parsed = parseUrlScheme(track.path ?? "");
  if (parsed.scheme === "file") return { kind: "file", path: parsed.path };
  if (parsed.scheme === "subsonic") {
    const url = await invoke<string>("resolve_subsonic_location", { location: parsed.url });
    return { kind: "http", url };
  }
  throw new Error(`Unsupported quiz source: ${track.path}`);
}

export function MusicQuizView({ playClip, seekClip, stopClip }: MusicQuizViewProps) {
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

  // The snippet now playing (or last played) — its key filters the engine
  // events, its source is what Replay reopens.
  const clipKeyRef = useRef<string | null>(null);
  const sourceRef = useRef<EngineSource | null>(null);
  // The clip has reported a duration — the window is clamped once per clip.
  const durationSeenRef = useRef(false);
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
    if (clipKeyRef.current) stopClip(clipKeyRef.current);
    setSnippetPlaying(false);
  }, [stopClip]);

  /** Open the current question's source and play from the window's start. */
  const startSnippet = useCallback(() => {
    const source = sourceRef.current;
    const win = windowRef.current;
    if (!source || !win) return;
    durationSeenRef.current = false;
    setSnippetProgress(0);
    // A main play (the bar, a media key, the assistant) took the engine: the
    // clip's events stop here, so drop back to "replay" instead of freezing
    // on "playing". Replaying takes the engine back.
    const onLost = () => {
      if (clipKeyRef.current !== key) return;
      clipKeyRef.current = null;
      setSnippetPlaying(false);
    };
    const { key, started } = playClip(source, win.start, { onLost });
    clipKeyRef.current = key;
    started
      .then(() => {
        if (clipKeyRef.current === key) setSnippetPlaying(true);
      })
      .catch((e) => {
        console.error("Failed to start quiz snippet:", e);
        if (clipKeyRef.current === key) snippetFailedRef.current();
      });
  }, [playClip]);

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
      if (clipKeyRef.current) stopClip(clipKeyRef.current);
      clipKeyRef.current = null;
    };
  }, [clearTimers, stopClip]);

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
    // A snippet that fails to resolve is retried with a fresh question, up to 3 times.
    for (;;) {
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
        const source = await resolveQuizSource(q.correct);
        if (gen !== genRef.current) return;
        windowRef.current = { start: q.snippetStart, len: q.snippetLen };
        sourceRef.current = source;
        setQuestion(q);
        setPhase("question");
        startSnippet();
      } catch (e) {
        console.error("Failed to resolve quiz snippet source:", e);
        if (gen !== genRef.current) return;
        if (retriesRef.current < 3) {
          retriesRef.current++;
          continue;
        }
        finishGame("error");
      }
      return;
    }
  }, [finishGame, startSnippet]);

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

  // --- engine events --------------------------------------------------------
  // Filtered by the clip's key: the engine also reports the main player's
  // sessions, and an older snippet's events can still be in flight.

  const handleSnippetError = useCallback(() => {
    console.error("Quiz snippet failed to load/decode; swapping question");
    setSnippetPlaying(false);
    if (phase !== "question" && phase !== "loading") return;
    if (retriesRef.current < 3) {
      retriesRef.current++;
      void loadQuestion();
    } else {
      finishGame("error");
    }
  }, [phase, loadQuestion, finishGame]);
  // Read by the once-mounted event subscriptions and by startSnippet.
  const snippetFailedRef = useRef(handleSnippetError);
  useAssignRef(snippetFailedRef, handleSnippetError);

  useEffect(() => {
    const ours = (key: string) => key === clipKeyRef.current;
    return combineUnlisten(
      subscribe<EngineDurationEvent>("engine-duration", ({ payload }) => {
        if (!ours(payload.trackKey) || durationSeenRef.current) return;
        durationSeenRef.current = true;
        // The DB's duration tag can overstate the real file length (bad
        // metadata, truncated files) — a window past the end would play
        // nothing. Clamp it to what the decoder actually reports.
        const win = windowRef.current;
        if (!win || !(payload.durationSecs > 0) || win.start < payload.durationSecs) return;
        windowRef.current = { start: 0, len: Math.min(win.len, payload.durationSecs) };
        seekClip(payload.trackKey, 0);
      }),
      subscribe<EnginePositionEvent>("engine-position", ({ payload }) => {
        if (!ours(payload.trackKey)) return;
        const win = windowRef.current;
        if (!win) return;
        retriesRef.current = 0;
        const elapsed = payload.positionSecs - win.start;
        setSnippetProgress(Math.min(1, Math.max(0, elapsed / win.len)));
        if (elapsed >= win.len) {
          stopClip(payload.trackKey);
          setSnippetPlaying(false);
          setSnippetProgress(1);
        }
      }),
      // Very short tracks can hit EOF before the position cutoff fires.
      subscribe<EngineEndedEvent>("engine-ended", ({ payload }) => {
        if (!ours(payload.trackKey)) return;
        setSnippetPlaying(false);
        setSnippetProgress(1);
      }),
      subscribe<EngineErrorEvent>("engine-error", ({ payload }) => {
        if (!ours(payload.trackKey)) return;
        console.error(`Quiz snippet engine error (${payload.code}):`, payload.message);
        snippetFailedRef.current();
      }),
    );
  }, [seekClip, stopClip]);

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
    startSnippet();
  }, [phase, startSnippet]);

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
                <div className="quiz-wire-row" key={track.id ?? i}>
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
    </div>
  );
}
