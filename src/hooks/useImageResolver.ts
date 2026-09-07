import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../utils/tauriEvents";
import type { ImageFetchResult } from "../types/plugin";

type InvokeImageFetch = (
  pluginId: string,
  entity: "artist" | "album" | "tag",
  name: string,
  artistName?: string,
) => Promise<ImageFetchResult>;

/**
 * Answers the backend image worker's `image-resolve-request` for **one** plugin
 * provider, named in the payload as `plugin_id`.
 *
 * This used to walk the whole provider chain here in JS, reading the priority
 * order out of `get_image_providers` itself. It can't any more, and shouldn't:
 * the built-in providers (folder art, embedded artwork) are rows in that same
 * ordered list, and running them means touching the filesystem and audio tags —
 * so the chain is walked in Rust (`resolve_entity_image`) and this hook is a
 * dumb one-provider fetcher. That also puts the "all providers failed" verdict
 * and the 24h failure record in one place instead of two.
 */
export function useImageResolver(invokeImageFetch: InvokeImageFetch) {
  useEffect(() => {
    return subscribe<{
      request_id: string;
      plugin_id: string;
      entity: "artist" | "album" | "tag";
      name?: string;
      title?: string;
      artist_name?: string;
    }>("image-resolve-request", async (event) => {
      const { request_id, plugin_id, entity, name, title, artist_name } = event.payload;
      const resolvedName = name || title || "";

      try {
        const result = await invokeImageFetch(plugin_id, entity, resolvedName, artist_name);

        if (result.status === "ok") {
          const response: Record<string, unknown> = {};
          if ("url" in result) response.url = result.url;
          if ("headers" in result && result.headers) response.headers = result.headers;
          if ("data" in result) response.data = result.data;
          await invoke("image_resolve_response", { requestId: request_id, result: response });
          return;
        }

        // not_found / error: report it and let the backend try the next provider.
        const message =
          result.status === "error" && "message" in result
            ? String(result.message)
            : "not found";
        if (result.status === "error") {
          console.warn(`[useImageResolver] ${plugin_id} error for ${entity}:${resolvedName}: ${message}`);
        }
        await invoke("image_resolve_response", {
          requestId: request_id,
          result: { error: message },
        });
      } catch (e) {
        console.error("[useImageResolver] error:", e);
        await invoke("image_resolve_response", {
          requestId: request_id,
          result: { error: String(e) },
        }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: error already reported in the response payload
      }
    });
  }, [invokeImageFetch]);
}
