import { useState, useCallback } from "react";

export function useSessionLog() {
  const [sessionLog, setSessionLog] = useState<{ time: Date; message: string }[]>([]);
  const [statusHint, setStatusHint] = useState<string | null>(null);

  const addLog = useCallback((message: string) => {
    setSessionLog(prev => [...prev, { time: new Date(), message }]);
  }, []);

  return { sessionLog, addLog, statusHint, setStatusHint };
}
