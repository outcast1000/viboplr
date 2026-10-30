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

export const AI_ACCESS_LEVELS: ReadonlyArray<{ level: AiAccessLevel; label: string; description: string }> = [
  {
    level: "off",
    label: "Off",
    description: "No assistant can reach Vibo. The control server isn't running.",
  },
  {
    level: "low",
    label: "Low",
    description:
      "Assistants can search your library, control playback, and edit the queue, playlists, likes and library tags. It can't change your files, make plugins act, or click in the window.",
  },
  {
    level: "full",
    label: "Full",
    description:
      "Everything in Low, plus writing tags into files, managing and deleting files, downloads, plugin actions, and clicking and typing in Vibo's window. Every change is logged below; you can pause the assistant at any time.",
  },
  {
    level: "custom",
    label: "Custom",
    description: "Everything in Low, plus exactly the permissions you switch on below.",
  },
];
