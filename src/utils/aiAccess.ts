// Settings → AI control's single access control: Off / Low / Full / Custom.
//
// The level is derived, never stored. Off is the control API being off
// (`controlApiEnabled`); with it on, the level is read off the six write
// scopes in `assistant-permissions.json` (Rust-owned, re-read per request —
// `assistant_write.rs` `WriteScopes::access_level` is the same rule): none on
// is Low, all on is Full, any mix is Custom. Picking a level only writes
// those scopes, so the Rust gate stays the one authorization.

/** Shape of `assistant_scopes_get`/`_set` (assistant_write.rs WriteScopes). */
export interface AssistantScopes {
  modifyTags: boolean;
  manageFiles: boolean;
  downloads: boolean;
  pluginActions: boolean;
  deleteTracks: boolean;
  uiInput: boolean;
}

export type AiAccessLevel = "off" | "low" | "full" | "custom";

export const SCOPE_KEYS: ReadonlyArray<keyof AssistantScopes> = [
  "modifyTags",
  "manageFiles",
  "downloads",
  "pluginActions",
  "deleteTracks",
  "uiInput",
];

function allScopes(on: boolean): AssistantScopes {
  return {
    modifyTags: on,
    manageFiles: on,
    downloads: on,
    pluginActions: on,
    deleteTracks: on,
    uiInput: on,
  };
}

export const LOW_SCOPES: AssistantScopes = allScopes(false);
export const FULL_SCOPES: AssistantScopes = allScopes(true);

export function aiAccessLevel(enabled: boolean, scopes: AssistantScopes): Exclude<AiAccessLevel, "off"> | "off" {
  if (!enabled) return "off";
  const on = SCOPE_KEYS.filter((k) => scopes[k]).length;
  if (on === 0) return "low";
  if (on === SCOPE_KEYS.length) return "full";
  return "custom";
}

/** The scopes a preset writes; Off and Custom leave them as they are. */
export function scopesForLevel(level: AiAccessLevel): AssistantScopes | null {
  if (level === "low") return LOW_SCOPES;
  if (level === "full") return FULL_SCOPES;
  return null;
}

// `summary` is always on screen, on every level's card, so the choice can be
// read before it is made (picking a level applies it at once); `description`
// is shown under the selected level only and adds to its summary rather than
// repeating it.
export const AI_ACCESS_LEVELS: ReadonlyArray<{
  level: AiAccessLevel;
  label: string;
  summary: string;
  description: string;
}> = [
  {
    level: "off",
    label: "Off",
    summary: "Assistants can't connect.",
    description: "Pick Low to connect an assistant — you can allow more later.",
  },
  {
    level: "low",
    label: "Low",
    summary: "Play, search, and edit the queue, playlists, likes and library tags. Never touches your files.",
    description:
      "It can't change your files, make plugins act, or click in the window. When you ask for one of those, the assistant tells you which setting it needs.",
  },
  {
    level: "full",
    label: "Full",
    summary: "Everything — also your files, downloads, plugins and clicking in the window. Asks first.",
    description:
      "That includes writing tags into files, moving and deleting files, and clicking anything in Vibo's window. Every change is logged below, and you can pause the assistant any time.",
  },
  {
    level: "custom",
    label: "Custom",
    summary: "Low, plus only the permissions you choose.",
    description:
      "Switch on what you want below. Picking Low or Full replaces your picks; Custom brings them back until you quit Vibo.",
  },
];
