// The markdown a chat model writes, parsed to plain data — no HTML is ever
// produced, so the renderer builds React elements and nothing a model (or a
// prompt-injected web page it read) writes can become markup. Covers what
// assistants actually emit: paragraphs, headings, bullet / numbered lists,
// fenced code, quotes, rules, pipe tables; inline code, bold, italic, links.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] };

export type MdBlock =
  | { kind: "p"; inline: MdInline[] }
  | { kind: "h"; level: 1 | 2 | 3; inline: MdInline[] }
  | { kind: "ul" | "ol"; items: MdInline[][]; start?: number }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; inline: MdInline[] }
  | { kind: "hr" }
  | { kind: "table"; header: MdInline[][]; rows: MdInline[][][] };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) ||
    RULE.test(line) || /^\s*>/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or end of input — an unclosed fence runs to the end)
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "h", level, inline: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) { blocks.push({ kind: "hr" }); i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", inline: parseInline(body.join("\n")) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const re = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) {
          items.push(ordered ? m[2] : m[1]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // A wrapped continuation line, or a nested item flattened into its parent.
          items[items.length - 1] += "\n" + lines[i].trim();
          i++;
        } else if (!lines[i].trim() && i + 1 < lines.length && re.test(lines[i + 1])) {
          i++; // a loose list: blank lines between items
        } else {
          break;
        }
      }
      const block: MdBlock = { kind: ordered ? "ol" : "ul", items: items.map(parseInline) };
      if (ordered && numbered) {
        const start = parseInt(numbered[1], 10);
        if (start !== 1) block.start = start;
      }
      blocks.push(block);
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
    const inline = parseInline(para.join("\n"));
    // A paragraph that was only a dropped image leaves nothing to show.
    if (inline.some((n) => n.kind !== "text" || n.text.trim())) blocks.push({ kind: "p", inline });
  }
  return blocks;
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  return /^https?:\/\//i.test(href) ? href : null;
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#|>-]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // `![alt](src)` is dropped whole. Pictures reach the chat only as message
    // `images` the plugin vetted; a model-written image link is a guess (or a
    // tracker), and rendered as text it read as a "!" plus a dead link.
    if (ch === "!" && src[i + 1] === "[") {
      const close = src.indexOf("]", i + 2);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end > close) {
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        const href = end > close ? safeHref(src.slice(close + 2, end)) : null;
        if (href) {
          flush();
          out.push({ kind: "link", href, children: parseInline(src.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }

    if ((ch === "*" || ch === "_") && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      // `_` only opens at a word boundary, so snake_case names stay intact.
      const opens = src[i + 1] && src[i + 1] !== " " && (ch === "*" || !/\w/.test(src[i - 1] ?? ""));
      if (opens) {
        let end = i + 1;
        while ((end = src.indexOf(ch, end)) !== -1) {
          if (src[end - 1] !== " " && src[end + 1] !== ch && (ch === "*" || !/\w/.test(src[end + 1] ?? ""))) break;
          end++;
        }
        if (end > i + 1) {
          flush();
          out.push({ kind: "em", children: parseInline(src.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}
