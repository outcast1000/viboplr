export interface TagEntry {
  name: string;
}

/**
 * Compute the list of tag names to send, flushing any pending (typed-but-not-committed)
 * input as a final tag. Case-insensitive de-dup against existing pills.
 */
export function effectiveTagNames(tags: TagEntry[], pendingInput: string): string[] {
  const pending = pendingInput.trim();
  const names = tags.map((t) => t.name);
  if (pending && !names.some((n) => n.toLowerCase() === pending.toLowerCase())) {
    names.push(pending);
  }
  return names;
}
