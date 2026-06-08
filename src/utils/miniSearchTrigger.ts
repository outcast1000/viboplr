// Pure predicate: should a keydown wake the mini-player search panel?
//
// A single printable character (letter/digit/punctuation) wakes search.
// Space, arrows, named keys, modifier combos, and IME composition do not —
// Space/arrows stay player controls in mini mode.

interface TriggerKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

interface TriggerState {
  miniMode: boolean;
  inputFocused: boolean;
  searchOpen: boolean;
}

export function shouldWakeMiniSearch(e: TriggerKeyEvent, state: TriggerState): boolean {
  if (!state.miniMode || state.inputFocused || state.searchOpen) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing) return false;
  // A printable character has a single-code-point `key`. Named keys
  // ("ArrowLeft", "Enter", "Tab", " ") are longer than 1 char — except Space,
  // whose key is a single " ", so exclude it explicitly.
  if (e.key === " ") return false;
  return [...e.key].length === 1;
}
