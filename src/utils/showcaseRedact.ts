/**
 * Showcase redaction: while the control API's showcase mode is on, hide given
 * strings (a user name in a plugin header, a personal playlist title) wherever
 * they render, so a scripted capture of the real app doesn't publish them.
 *
 * Works on the DOM rather than on component props because the strings come
 * from anywhere — a plugin's own view data, a header subtitle, a toast — and
 * no single component sees them all. React updates a text node in place
 * (`nodeValue`), so a MutationObserver re-applies the rules whenever React
 * writes, and `stop()` writes the originals back into every node it still
 * holds redacted. Session-only, like showcase itself.
 */

export interface RedactRule {
  text: string;
  replacement: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One case-insensitive pattern per rule, longest text first so a rule that
 *  contains another wins. */
export function compileRules(rules: RedactRule[]): Array<{ re: RegExp; replacement: string }> {
  return [...rules]
    .sort((a, b) => b.text.length - a.text.length)
    .map((r) => ({ re: new RegExp(escapeRegExp(r.text), "gi"), replacement: r.replacement }));
}

/** `text` with every rule applied (case-insensitive). */
export function redactText(text: string, compiled: ReturnType<typeof compileRules>): string {
  let out = text;
  for (const { re, replacement } of compiled) out = out.replace(re, () => replacement);
  return out;
}

/** Redact `root`'s text now and on every later change. Returns `stop`, which
 *  disconnects and restores the original text of every node still redacted. */
export function startRedaction(root: Node, rules: RedactRule[]): () => void {
  const compiled = compileRules(rules);
  if (compiled.length === 0) return () => {};
  // node → the text React wrote and the redacted text we replaced it with.
  const held = new Map<Text, { original: string; redacted: string }>();

  const apply = (node: Text) => {
    const value = node.nodeValue ?? "";
    const seen = held.get(node);
    if (seen && value === seen.redacted) return; // our own write echoing back
    const redacted = redactText(value, compiled);
    if (redacted === value) {
      held.delete(node);
      return;
    }
    held.set(node, { original: value, redacted });
    node.nodeValue = redacted;
  };

  const walk = (start: Node) => {
    if (start.nodeType === Node.TEXT_NODE) {
      apply(start as Text);
      return;
    }
    const doc = start.ownerDocument ?? (start as Document);
    const walker = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) apply(n as Text);
  };

  walk(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") apply(r.target as Text);
      else r.addedNodes.forEach(walk);
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true });

  return () => {
    observer.disconnect();
    for (const [node, { original, redacted }] of held) {
      if (node.isConnected && node.nodeValue === redacted) node.nodeValue = original;
    }
    held.clear();
  };
}
