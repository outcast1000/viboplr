import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ImageFetchResult } from "../types/plugin";

type InvokeImageFetch = (
  pluginId: string,
  entity: "artist" | "album",
  name: string,
  artistName?: string,
) => Promise<ImageFetchResult>;

export function useImageResolver(invokeImageFetch: InvokeImageFetch) {
  useEffect(() => {
    const unlisten = listen<{
      request_id: string;
      entity: "artist" | "album";
      id: number;
      name?: string;
      title?: string;
      artist_name?: string;
    }>("image-resolve-request", async (event) => {
      const { request_id, entity, name, title, artist_name } = event.payload;
      const resolvedName = name || title || "";

      try {
        // Get active providers in priority order
        const providers = await invoke<[string, number, number][]>(
          "get_image_providers",
          { entity }
        );

        // Try each provider in sequence (fallback chain)
        for (const [pluginId] of providers) {
          const result = await invokeImageFetch(pluginId, entity, resolvedName, artist_name);
          if (result.status === "ok") {
            // Extract url/headers/data depending on which variant
            const response: Record<string, unknown> = {};
            if ("url" in result) response.url = result.url;
            if ("headers" in result && result.headers) response.headers = result.headers;
            if ("data" in result) response.data = result.data;

            await invoke("image_resolve_response", {
              requestId: request_id,
              result: response,
            });
            return;
          }
          // not_found or error: log and try next provider
          if (result.status === "error" && "message" in result) {
            console.warn(`[useImageResolver] ${pluginId} error for ${entity}:${resolvedName}: ${result.message}`);
          }
        }

        // All providers failed
        await invoke("image_resolve_response", {
          requestId: request_id,
          result: { error: "all providers failed" },
        });
      } catch (e) {
        console.error("[useImageResolver] error:", e);
        await invoke("image_resolve_response", {
          requestId: request_id,
          result: { error: String(e) },
        }).catch(() => {});
      }
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [invokeImageFetch]);
}
