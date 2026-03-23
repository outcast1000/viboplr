import { useState, useCallback } from "react";

export function useSessionLog() {
  const [sessionLog, setSessionLog] = useState<{ time: Date; message: string }[]>([]);

  const addLog = useCallback((message: string) => {
    setSessionLog(prev => [...prev, { time: new Date(), message }]);
  }, []);

  return { sessionLog, addLog };
}
