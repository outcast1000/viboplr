import type { Track } from "../types";
import { isLocalTrack } from "../queueEntry";

// Pure logic for the Song Quiz game — an arcade beat-the-clock round:
// name as many snippets as you can before the clock hits zero. Correct
// answers add time, wrong answers cost time. Everything takes an injectable
// `rand` (0..1) so tests are deterministic.

export type QuizModeId = "easy" | "medium" | "hard";

export interface QuizMode {
  id: QuizModeId;
  label: string;
  /** Seconds on the clock at game start. */
  startSecs: number;
  /** Seconds gained on a correct answer. */
  bonusSecs: number;
  /** Seconds lost on a wrong answer. */
  penaltySecs: number;
  /** Seconds lost when skipping a question. */
  skipSecs: number;
  /** Snippet length in seconds. */
  snippetSecs: number;
  /** Prefer wrong answers by the same artist (much harder to tell apart). */
  sameArtistDistractors: boolean;
}

export const QUIZ_MODES: QuizMode[] = [
  { id: "easy", label: "Easy", startSecs: 120, bonusSecs: 10, penaltySecs: 5, skipSecs: 3, snippetSecs: 10, sameArtistDistractors: false },
  { id: "medium", label: "Medium", startSecs: 90, bonusSecs: 6, penaltySecs: 10, skipSecs: 5, snippetSecs: 6, sameArtistDistractors: false },
  { id: "hard", label: "Hard", startSecs: 60, bonusSecs: 4, penaltySecs: 15, skipSecs: 8, snippetSecs: 4, sameArtistDistractors: true },
];

export function getQuizMode(id: QuizModeId): QuizMode {
  return QUIZ_MODES.find((m) => m.id === id) ?? QUIZ_MODES[0];
}

/** Formats remaining seconds as m:ss, never below 0:00. */
export function formatClock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Best score per mode, persisted in the app store as `quizBestScores`. */
export type QuizBestScores = Partial<Record<QuizModeId, number>>;

/** Parses a persisted best-scores value defensively (store may hold junk). */
export function normalizeBestScores(raw: unknown): QuizBestScores {
  const out: QuizBestScores = {};
  if (raw && typeof raw === "object") {
    for (const mode of QUIZ_MODES) {
      const value = (raw as Record<string, unknown>)[mode.id];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[mode.id] = Math.floor(value);
      }
    }
  }
  return out;
}

export interface QuizQuestion {
  /** The track whose snippet is played. */
  correct: Track;
  /** All 4 answer options (correct + 3 distractors), shuffled. */
  options: Track[];
  /** Index of `correct` within `options`. */
  correctIndex: number;
  /** Snippet start offset in seconds. */
  snippetStart: number;
  /** Snippet length in seconds. */
  snippetLen: number;
}

/**
 * Picks a random snippet window inside a track, avoiding the first/last 10%
 * (intros/outros are the least recognizable part). Falls back to the start
 * for tracks too short to offset into.
 */
export function pickSnippetWindow(
  durationSecs: number,
  snippetLen: number,
  rand: () => number,
): { start: number; len: number } {
  const len = Math.min(snippetLen, durationSecs);
  const lo = durationSecs * 0.1;
  const hi = durationSecs * 0.9 - len;
  if (hi <= lo) return { start: 0, len };
  return { start: lo + rand() * (hi - lo), len };
}

/** Case- and diacritic-insensitive title identity for distractor dedup. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

// Formats the webview <audio> element can decode. Non-browser-native formats
// (APE, WV, DSF, …) only play through the mpv engine, which the quiz's private
// audio element can't use — so they're excluded from the question pool.
const BROWSER_PLAYABLE_FORMATS = new Set([
  "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "webm",
]);

/**
 * Tracks usable as quiz questions: library rows with a title + artist, long
 * enough to cut a snippet from, on a source the quiz's own <audio> element can
 * play (local file or Subsonic stream) in a browser-decodable format.
 */
export function eligibleQuizTracks(tracks: Track[]): Track[] {
  return tracks.filter((t) => {
    if (t.id == null || !t.title?.trim() || !t.artist_name?.trim()) return false;
    if (t.duration_secs == null || t.duration_secs < 45) return false;
    const playableSource = isLocalTrack(t) || !!t.path?.startsWith("subsonic://");
    if (!playableSource) return false;
    return !!t.format && BROWSER_PLAYABLE_FORMATS.has(t.format.toLowerCase());
  });
}

/** Whether the library can sustain a game (4 distinct answer titles). */
export function hasEnoughQuizTracks(tracks: Track[]): boolean {
  const titles = new Set<string>();
  for (const t of eligibleQuizTracks(tracks)) {
    titles.add(normalizeTitle(t.title));
    if (titles.size >= 4) return true;
  }
  return false;
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Builds one question: a random not-yet-used track plus 3 distractors with
 * distinct titles. With `sameArtistDistractors` (Hard mode), distractors
 * prefer the correct track's artist. Returns null when the pool can't supply
 * 4 distinct titles.
 */
export function buildQuestion(
  tracks: Track[],
  mode: Pick<QuizMode, "snippetSecs" | "sameArtistDistractors">,
  usedIds: Set<number>,
  rand: () => number,
): QuizQuestion | null {
  const pool = eligibleQuizTracks(tracks);
  if (pool.length < 4) return null;

  const candidates = shuffle(pool.filter((t) => !usedIds.has(t.id!)), rand);
  const fallbackCandidates = candidates.length > 0 ? candidates : shuffle(pool, rand);

  for (const correct of fallbackCandidates) {
    const correctTitle = normalizeTitle(correct.title);
    const takenTitles = new Set([correctTitle]);
    const distractors: Track[] = [];

    const take = (source: Track[]) => {
      for (const t of source) {
        if (distractors.length >= 3) return;
        if (t.id === correct.id) continue;
        const title = normalizeTitle(t.title);
        if (takenTitles.has(title)) continue;
        takenTitles.add(title);
        distractors.push(t);
      }
    };

    if (mode.sameArtistDistractors && correct.artist_name) {
      take(shuffle(pool.filter((t) => t.artist_name === correct.artist_name), rand));
    }
    take(shuffle(pool, rand));
    if (distractors.length < 3) continue;

    const options = shuffle([correct, ...distractors], rand);
    const { start, len } = pickSnippetWindow(
      correct.duration_secs ?? 0,
      mode.snippetSecs,
      rand,
    );
    return {
      correct,
      options,
      correctIndex: options.indexOf(correct),
      snippetStart: start,
      snippetLen: len,
    };
  }
  return null;
}

/**
 * 50:50 lifeline — the two wrong option indices to eliminate, leaving the
 * correct answer and one random wrong one.
 */
export function fiftyFiftyRemovals(
  optionCount: number,
  correctIndex: number,
  rand: () => number,
): number[] {
  const wrong: number[] = [];
  for (let i = 0; i < optionCount; i++) if (i !== correctIndex) wrong.push(i);
  const shuffled = shuffle(wrong, rand);
  return shuffled.slice(0, Math.max(0, wrong.length - 1)).sort((a, b) => a - b);
}
