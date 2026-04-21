import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useSessionLog() {
  const [sessionLog, setSessionLog] = useState<{ time: Date; message: string }[]>([]);
  const debugLoggingRef = useRef(false);

  const setDebugLogging = useCallback((enabled: boolean) => {
    debugLoggingRef.current = enabled;
  }, []);

  const addLog = useCallback((message: string, module?: string) => {
    setSessionLog(prev => [...prev, { time: new Date(), message }]);
    if (debugLoggingRef.current) {
      const section = module ? `fr-${module}` : "fr-app";
      invoke("write_frontend_log", { level: "info", message, section }).catch(() => {});
    }
  }, []);

  return { sessionLog, addLog, setDebugLogging };
}
