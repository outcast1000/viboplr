import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { store } from "../store";
import { isVideoTrack } from "../utils";

export interface AutoContinueWeights {
  random: number;
  sameArtist: number;
  sameTag: number;
  mostPlayed: number;
  liked: number;
}

const STRATEGY_KEYS: (keyof AutoContinueWeights)[] = [
  "random", "sameArtist", "sameTag", "mostPlayed", "liked",
];

const STRATEGY_MAP: Record<keyof AutoContinueWeights, string> = {
  random: "random",
  sameArtist: "same_artist",
  sameTag: "same_tag",
  mostPlayed: "most_played",
  liked: "liked",
};

const DEFAULT_WEIGHTS: AutoContinueWeights = {
  random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10,
};

export function useAutoContinue(restoredRef: React.RefObject<boolean>) {
  const [enabled, setEnabled] = useState(false);
  const [sameFormat, setSameFormat] = useState(false);
  const [weights, setWeights] = useState<AutoContinueWeights>(DEFAULT_WEIGHTS);
  const [showPopover, setShowPopover] = useState(false);

  // Restore from store
  useEffect(() => {
    (async () => {
      const [en, w, sf] = await Promise.all([
        store.get<boolean>("autoContinueEnabled"),
        store.get<AutoContinueWeights>("autoContinueWeights"),
        store.get<boolean>("autoContinueSameFormat"),
      ]);
      if (en !== undefined && en !== null) setEnabled(en);
      if (w) setWeights(w);
      if (sf !== undefined && sf !== null) setSameFormat(sf);
    })();
  }, []);

  // Persist
  useEffect(() => {
    if (restoredRef.current) store.set("autoContinueEnabled", enabled);
  }, [enabled]);
  useEffect(() => {
    if (restoredRef.current) store.set("autoContinueWeights", weights);
  }, [weights]);
  useEffect(() => {
    if (restoredRef.current) store.set("autoContinueSameFormat", sameFormat);
  }, [sameFormat]);

  function pickStrategy(): string {
    const roll = Math.floor(Math.random() * 100);
    let cumulative = 0;
    for (const key of STRATEGY_KEYS) {
      cumulative += weights[key];
      if (roll < cumulative) return STRATEGY_MAP[key];
    }
    return "random";
  }

  async function fetchTrack(currentTrack: Track, excludeIds?: number[]): Promise<Track | null> {
    const strategy = pickStrategy();
    const formatFilter = sameFormat ? (isVideoTrack(currentTrack) ? "video" : "audio") : null;
    try {
      const track = await invoke<Track | null>("get_auto_continue_track", {
        strategy,
        currentTrackId: currentTrack.id,
        formatFilter,
        excludeIds: excludeIds ?? null,
      });
      if (track) return track;
      // Fallback to random if strategy returned nothing
      if (strategy !== "random") {
        return await invoke<Track | null>("get_auto_continue_track", {
          strategy: "random",
          currentTrackId: currentTrack.id,
          formatFilter,
          excludeIds: excludeIds ?? null,
        });
      }
      return null;
    } catch {
      return null;
    }
  }

  function adjustWeight(key: keyof AutoContinueWeights, newValue: number) {
    setWeights(prev => {
      const clamped = Math.max(0, Math.min(100, newValue));
      const oldValue = prev[key];
      const diff = clamped - oldValue;
      if (diff === 0) return prev;

      const others = STRATEGY_KEYS.filter(k => k !== key);
      const othersSum = others.reduce((s, k) => s + prev[k], 0);

      const next = { ...prev, [key]: clamped };

      if (othersSum === 0) {
        // Distribute remaining evenly among others
        const remaining = 100 - clamped;
        const each = Math.floor(remaining / others.length);
        let leftover = remaining - each * others.length;
        for (const k of others) {
          next[k] = each + (leftover > 0 ? 1 : 0);
          if (leftover > 0) leftover--;
        }
      } else {
        // Proportionally redistribute
        const newOthersSum = 100 - clamped;
        let distributed = 0;
        for (let i = 0; i < others.length; i++) {
          if (i === others.length - 1) {
            next[others[i]] = Math.max(0, newOthersSum - distributed);
          } else {
            const proportion = prev[others[i]] / othersSum;
            const val = Math.max(0, Math.round(proportion * newOthersSum));
            next[others[i]] = val;
            distributed += val;
          }
        }
      }

      return next;
    });
  }

  return {
    enabled, setEnabled,
    sameFormat, setSameFormat,
    weights, adjustWeight,
    showPopover, setShowPopover,
    fetchTrack,
  };
}
