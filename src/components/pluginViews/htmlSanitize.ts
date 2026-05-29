// HTML sanitization for plugin-provided rich text (split out of PluginViewRenderer.tsx).

const ALLOWED_TAGS = new Set([
  "b",
  "i",
  "em",
  "strong",
  "h2",
  "h3",
  "p",
  "pre",
  "br",
  "a",
  "ul",
  "ol",
  "li",
  "div",
  "span",
  "code",
  "img",
]);

export function sanitizeHTML(html: string): string {
  // Strip tags not in allowlist
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => {
    return ALLOWED_TAGS.has(tag.toLowerCase()) ? match : "";
  });
}
