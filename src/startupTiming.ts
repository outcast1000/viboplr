export interface TimingEntry {
  label: string;
  duration_ms: number;
  offset_ms: number;
}

const entries: TimingEntry[] = [];
const origin = performance.now();

export async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  entries.push({
    label,
    duration_ms: performance.now() - start,
    offset_ms: start - origin,
  });
  return result;
}

export function getTimingEntries(): TimingEntry[] {
  return [...entries];
}
