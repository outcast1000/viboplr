import type { PluginTreeNode } from "../types/plugin";

/**
 * The pure half of the plugin `tree` view node (`components/pluginViews/
 * PluginTree.tsx`): which rows are visible, and what a navigation key does.
 * Kept out of the component so the keyboard map — the part most likely to be
 * wrong and least likely to be noticed — is asserted without a DOM.
 */

/** One visible line of the tree. `loading` is the placeholder under an
 *  expanded lazy node whose children haven't arrived yet. */
export type TreeRow =
  | { kind: "node"; node: PluginTreeNode; depth: number; parentId: string | null; expandable: boolean; expanded: boolean }
  | { kind: "loading"; depth: number; parentId: string };

export function isExpandable(node: PluginTreeNode): boolean {
  return !!node.hasChildren || (node.children?.length ?? 0) > 0;
}

/** Depth-first rows for the expanded part of the tree. */
export function flattenTree(nodes: PluginTreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: PluginTreeNode[], depth: number, parentId: string | null) => {
    for (const node of list) {
      const expandable = isExpandable(node);
      const open = expandable && expanded.has(node.id);
      rows.push({ kind: "node", node, depth, parentId, expandable, expanded: open });
      if (!open) continue;
      if (node.children && node.children.length > 0) walk(node.children, depth + 1, node.id);
      else if (!node.children) rows.push({ kind: "loading", depth: depth + 1, parentId: node.id });
      // `children: []` — loaded and empty: the chevron just opens onto nothing.
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/**
 * A row's identity for React keys, DOM ids and the keyboard cursor. The kind
 * is a prefix, so no plugin id can collide with a loading row: a placeholder
 * id built by suffixing the parent's (`<id>::loading`) clashed with any node a
 * plugin happened to name that way, and two rows then shared a key and a DOM
 * id (the cursor and `aria-activedescendant` pointed at the wrong one).
 */
export function rowKey(row: TreeRow): string {
  return row.kind === "node" ? nodeKey(row.node.id) : `l:${row.parentId}`;
}

/** The `rowKey` of the node row with this plugin id. */
export function nodeKey(id: string): string {
  return `n:${id}`;
}

/** What a key does at the cursor. `none` = not a tree key (let it through). */
export type TreeKeyResult =
  | { type: "move"; index: number }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "select"; id: string }
  | { type: "none" };

/**
 * The WAI-ARIA tree keyboard pattern, on the flattened rows:
 * ↑/↓ step, Home/End jump, → expands a closed node or steps into an open one's
 * first child, ← collapses an open node or steps out to the parent, Enter /
 * Space select. The loading placeholder can hold the cursor (it's a visible
 * row) but can't be selected.
 *
 * `index` -1 means the cursor is on no row — never placed (a row that went
 * away is moved by `relocateCursor` first). ↑/↓/Home/End then
 * place it; →/←/Enter/Space do **nothing** (`none`, so the key is free for the
 * window's own shortcuts). Clamping -1 to row 0 used to make Enter select, and
 * → expand, a row the user was never on.
 */
export function treeKey(rows: TreeRow[], index: number, key: string): TreeKeyResult {
  if (rows.length === 0) return { type: "none" };
  const placed = index >= 0 && index < rows.length;
  switch (key) {
    case "ArrowDown":
      return { type: "move", index: placed ? Math.min(index + 1, rows.length - 1) : 0 };
    case "ArrowUp":
      return { type: "move", index: placed ? Math.max(index - 1, 0) : 0 };
    case "Home":
      return { type: "move", index: 0 };
    case "End":
      return { type: "move", index: rows.length - 1 };
  }
  if (!placed) return { type: "none" };
  const at = index;
  const row = rows[at];
  switch (key) {
    case "ArrowRight":
      if (row.kind !== "node" || !row.expandable) return { type: "move", index: at };
      if (!row.expanded) return { type: "expand", id: row.node.id };
      // Open: step into the first child (or its loading row).
      return at + 1 < rows.length && rows[at + 1].parentId === row.node.id
        ? { type: "move", index: at + 1 }
        : { type: "move", index: at };
    case "ArrowLeft": {
      if (row.kind === "node" && row.expanded) return { type: "collapse", id: row.node.id };
      const parent = row.parentId;
      if (parent === null) return { type: "move", index: at };
      const p = rows.findIndex((r) => r.kind === "node" && r.node.id === parent);
      return { type: "move", index: p >= 0 ? p : at };
    }
    case "Enter":
    case " ":
      return row.kind === "node" ? { type: "select", id: row.node.id } : { type: "none" };
    default:
      return { type: "none" };
  }
}

/**
 * Where the keyboard cursor goes when its row is no longer drawn (`prev` → `rows`),
 * so the next ↓ continues from where the user was instead of jumping to row 0.
 * - A **loading row** replaced by its children lands on the first child (it held
 *   that position), or on the parent when the node opened onto nothing.
 * - Any other vanished row (its parent collapsed, the plugin redrew without it)
 *   lands on its **nearest surviving ancestor**.
 * - With no ancestor left, it keeps its position (clamped), or `null` on an
 *   empty tree.
 * A key still present, or `null`, is returned unchanged.
 */
export function relocateCursor(prev: TreeRow[], rows: TreeRow[], key: string | null): string | null {
  if (key === null || rows.some((r) => rowKey(r) === key)) return key;
  const at = prev.findIndex((r) => rowKey(r) === key);
  if (at < 0) return null;
  const was = prev[at];
  const indexOfNode = (id: string) => rows.findIndex((r) => r.kind === "node" && r.node.id === id);
  if (was.kind === "loading") {
    const p = indexOfNode(was.parentId);
    if (p >= 0) {
      const first = rows[p + 1];
      return first && first.parentId === was.parentId ? rowKey(first) : nodeKey(was.parentId);
    }
  }
  const parentOf = new Map<string, string | null>();
  for (const r of prev) if (r.kind === "node") parentOf.set(r.node.id, r.parentId);
  for (let p = was.parentId; p !== null; p = parentOf.get(p) ?? null) {
    if (indexOfNode(p) >= 0) return nodeKey(p);
  }
  return rows.length === 0 ? null : rowKey(rows[Math.min(at, rows.length - 1)]);
}

/**
 * Which lazy nodes to ask the plugin for (`expandAction`), given the ids already
 * asked. A node needs asking while its loading row is drawn — whether the user
 * opened it or `expandedIds` did; a seeded one was never asked before this and
 * showed "Loading…" forever. `asked` is returned pruned to the nodes still
 * waiting, so a node asked once isn't asked again until its loading row goes
 * away (children arrived, or it collapsed) and comes back.
 */
export function lazyExpandRequests(rows: TreeRow[], asked: ReadonlySet<string>): { request: string[]; asked: Set<string> } {
  const waiting = new Set<string>();
  for (const r of rows) if (r.kind === "loading") waiting.add(r.parentId);
  const request: string[] = [];
  for (const id of waiting) if (!asked.has(id)) request.push(id);
  return { request, asked: waiting };
}

/** A click the plugin hasn't answered yet: the node clicked, and the
 *  `selectedId` the tree showed when it was clicked. */
export interface PendingSelection {
  id: string;
  base: string | undefined;
}

/**
 * Which node to draw as selected while a click is pending. The pending mark
 * wins only while the plugin's `selectedId` is still the one the click was made
 * against. The component also drops the pending mark on the plugin's next
 * answer (any new `nodes`), whatever it says — a plugin that ignores the click
 * (a header it doesn't select) would otherwise leave the mark up for good.
 */
export function effectiveSelectedId(selectedId: string | undefined, pending: PendingSelection | null): string | undefined {
  return pending && pending.base === selectedId ? pending.id : selectedId;
}

type TreeEntity = NonNullable<PluginTreeNode["entity"]>;

/** One entity's artwork identity (kind + names), as a string key. */
export function entityImageKey(e: TreeEntity): string {
  return `${e.kind}\u0001${e.name}\u0001${e.artistName ?? ""}`;
}

/** The distinct visible entities that need artwork from the shared cache
 *  (a node with its own `imageUrl` doesn't), in row order. */
export function entitiesNeedingArt(rows: TreeRow[]): TreeEntity[] {
  const seen = new Set<string>();
  const out: TreeEntity[] = [];
  for (const r of rows) {
    if (r.kind !== "node" || r.node.imageUrl || !r.node.entity) continue;
    const k = entityImageKey(r.node.entity);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.node.entity);
  }
  return out;
}

/** `entitiesNeedingArt` as one string, so artwork work runs when that SET
 *  changes — not on every new (but equal) node tree a plugin answer brings. */
export function entityPrimeSignature(rows: TreeRow[]): string {
  return entitiesNeedingArt(rows).map(entityImageKey).join("\u0000");
}

/** Stable signature of an `expandedIds` prop, so a plugin re-sending the same
 *  list on every render doesn't reset the user's own expansion. */
export function expandedSignature(ids: string[] | undefined): string {
  return ids ? ids.join("\u0000") : "";
}
