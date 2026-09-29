/**
 * Pure BSP layout primitives for the Awen workbench.
 *
 * Adopted from `hardbeat920/monocode@25dd57e599e33a1878ce7e45a3187f7863b8d74f`
 * (`src/lib/layout.ts`) and pruned to the surface that v1 needs: the split
 * tree, leaf/sash geometry, drop-edge math, and split/remove/move operations.
 *
 * Pruned (kept out of v1 by design, see ADR `0001-monocode-layout-adoption.md`):
 *   - `FilePaneTab`, `EditorPane`, `terminalPanes`, `SurfaceKind`
 *   - `openEditorTab`, `openTerminalTab`, `isolateTerminalPanes`, ...
 *   - `newTab`, `newEditorPane`, `newFileTab`, `newCommitTab`, `newPlanTab`,
 *     `newReleaseNotesWorkspaceTab`, `newAgentTab`, ...
 *   - plan / commit / release-notes / orchestration-worker tab sources
 *
 * The kept core is what C12 (cross-pane drag-drop) and C13–C14 (Scrolling
 * layout) will need too. Panes themselves are not modeled here — a Pane is a
 * leaf in this tree plus an external Pane View specification keyed by leaf id (see
 * `viewRegistry.ts` and `workbenchStore.ts`).
 */

export type SplitDir = "right" | "down";
export type FocusDir = "left" | "right" | "up" | "down";

export type LayoutNode =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      id: string;
      dir: SplitDir;
      children: LayoutNode[];
      sizes: number[];
    };

const MIN_SIZE = 0.08;

export function leaf(id: string): LayoutNode {
  return { type: "leaf", id };
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return equalSizes(sizes.length);
  return sizes.map((n) => n / total);
}

export type LayoutRect = { x: number; y: number; w: number; h: number };

export type LayoutLeaf = {
  id: string;
  rect: LayoutRect;
  axis: "x" | "y";
};

export type LayoutSash = {
  splitId: string;
  index: number;
  dir: SplitDir;
  group: LayoutRect;
  sizes: number[];
};

/**
 * One Awen Tab — C10 ships exactly one. Multi-tab is C11.
 *
 * A leaf id maps 1:1 to a Pane View specification held outside this module; the workbench
 * store keeps a `Map<leafId, PaneView>`. Closing a leaf drops it from both
 * the layout and the store. Resource cleanup for explicit close belongs to
 * the Workbench coordinator before this pure layout operation runs.
 */
export type AwenTab = {
  id: string;
  layout: LayoutNode;
  focusedPaneId: string;
};

export function newTab(initialPaneId: string = cryptoRandomId()): AwenTab {
  return {
    id: cryptoRandomId(),
    layout: leaf(initialPaneId),
    focusedPaneId: initialPaneId,
  };
}

export function splitPane(
  node: LayoutNode,
  focusedId: string,
  dir: SplitDir,
  newLeafId: string,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.id !== focusedId) return node;
    return {
      type: "split",
      id: cryptoRandomId(),
      dir,
      children: [node, leaf(newLeafId)],
      sizes: [0.5, 0.5],
    };
  }

  const direct = node.children.findIndex(
    (child) => child.type === "leaf" && child.id === focusedId,
  );

  if (direct >= 0) {
    if (node.dir === dir) {
      const children = [
        ...node.children.slice(0, direct + 1),
        leaf(newLeafId),
        ...node.children.slice(direct + 1),
      ];
      return { ...node, children, sizes: equalSizes(children.length) };
    }
    return {
      ...node,
      children: node.children.map((child, i) =>
        i === direct
          ? {
              type: "split",
              id: cryptoRandomId(),
              dir,
              children: [child, leaf(newLeafId)],
              sizes: [0.5, 0.5],
            }
          : child,
      ),
    };
  }

  return {
    ...node,
    children: node.children.map((child) => splitPane(child, focusedId, dir, newLeafId)),
  };
}

export function replaceLeafId(node: LayoutNode, fromId: string, toId: string): LayoutNode {
  if (fromId === toId) return node;
  if (node.type === "leaf") {
    return node.id === fromId ? leaf(toId) : node;
  }
  return {
    ...node,
    children: node.children.map((child) => replaceLeafId(child, fromId, toId)),
  };
}

/** Drop a leaf. Parent splits collapse to the remaining child. */
export function removePane(node: LayoutNode, leafId: string): LayoutNode | null {
  if (node.type === "leaf") return node.id === leafId ? null : node;

  const kept: { child: LayoutNode; size: number }[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === undefined) continue;
    const after = removePane(child, leafId);
    if (after) kept.push({ child: after, size: node.sizes[i] ?? 0 });
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) {
    const only = kept[0];
    if (only === undefined) return null;
    return only.child;
  }
  return {
    ...node,
    children: kept.map((item) => item.child),
    sizes: normalize(kept.map((item) => item.size)),
  };
}

/**
 * Close one pane in a tab. Returns null only when this was the last leaf.
 * Focus moves to the closed pane's sibling when the closed pane was focused.
 */
export function closeLeaf(tab: AwenTab, leafId: string): AwenTab | null {
  const nextLayout = removePane(tab.layout, leafId);
  if (!nextLayout) return null;
  const nextFocus =
    tab.focusedPaneId === leafId
      ? (siblingLeafId(tab.layout, leafId) ?? firstLeafId(nextLayout))
      : tab.focusedPaneId;
  return { ...tab, layout: nextLayout, focusedPaneId: nextFocus };
}

/** Move the sash between `index` and `index + 1` to `boundary` (0–1 of the group). */
export function setSplitRatio(
  node: LayoutNode,
  splitId: string,
  index: number,
  boundary: number,
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id !== splitId) {
    return {
      ...node,
      children: node.children.map((child) => setSplitRatio(child, splitId, index, boundary)),
    };
  }
  if (index < 0 || index >= node.sizes.length - 1) return node;

  return { ...node, sizes: splitSizesAtBoundary(node.sizes, index, boundary) };
}

export function splitSizesAtBoundary(current: number[], index: number, boundary: number): number[] {
  if (index < 0 || index >= current.length - 1) return current;
  const sizes = [...current];
  const before = sizes.slice(0, index).reduce((sum, n) => sum + n, 0);
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined) return current;
  const pair = a + b;
  const min = Math.min(MIN_SIZE, pair / 2);
  const first = Math.min(pair - min, Math.max(min, boundary - before));
  sizes[index] = first;
  sizes[index + 1] = pair - first;
  return sizes;
}

export function leafIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [node.id];
  return node.children.flatMap(leafIds);
}

export function firstLeafId(node: LayoutNode): string {
  if (node.type === "leaf") return node.id;
  const first = node.children[0];
  if (first === undefined) {
    throw new Error("firstLeafId: empty split node has no leaves");
  }
  return firstLeafId(first);
}

export function layoutLeaves(
  node: LayoutNode,
  rect: LayoutRect = { x: 0, y: 0, w: 1, h: 1 },
  parentDir?: SplitDir,
): LayoutLeaf[] {
  const axis = parentDir === "down" ? "y" : "x";
  if (node.type === "leaf") return [{ id: node.id, rect, axis }];
  const row = node.dir === "right";
  let offset = 0;
  const out: LayoutLeaf[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === undefined) continue;
    const size = node.sizes[i] ?? 0;
    const subRect: LayoutRect = row
      ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
    offset += size;
    out.push(...layoutLeaves(child, subRect, node.dir));
  }
  return out;
}

export function layoutSashes(
  node: LayoutNode,
  rect: LayoutRect = { x: 0, y: 0, w: 1, h: 1 },
): LayoutSash[] {
  if (node.type === "leaf") return [];
  const row = node.dir === "right";
  let offset = 0;
  const out: LayoutSash[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === undefined) continue;
    const size = node.sizes[i] ?? 0;
    if (i > 0) {
      out.push({
        splitId: node.id,
        index: i - 1,
        dir: node.dir,
        group: rect,
        sizes: node.sizes,
      });
    }
    const subRect: LayoutRect = row
      ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
    offset += size;
    out.push(...layoutSashes(child, subRect));
  }
  return out;
}

function leafRects(node: LayoutNode): LayoutLeaf[] {
  return layoutLeaves(node);
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Adjacent leaf in `dir`, preferring panes that share an edge. */
export function neighborLeafId(node: LayoutNode, focusedId: string, dir: FocusDir): string | null {
  const panes = leafRects(node);
  const current = panes.find((p) => p.id === focusedId);
  if (!current) return null;
  const c = current.rect;

  let best: { id: string; hit: number; gap: number; overlap: number } | null = null;
  for (const pane of panes) {
    if (pane.id === focusedId) continue;
    const r = pane.rect;
    let gap = Infinity;
    let perp = 0;
    if (dir === "left" && r.x + r.w <= c.x + 1e-6) {
      gap = c.x - (r.x + r.w);
      perp = rangeOverlap(c.y, c.y + c.h, r.y, r.y + r.h);
    } else if (dir === "right" && r.x >= c.x + c.w - 1e-6) {
      gap = r.x - (c.x + c.w);
      perp = rangeOverlap(c.y, c.y + c.h, r.y, r.y + r.h);
    } else if (dir === "up" && r.y + r.h <= c.y + 1e-6) {
      gap = c.y - (r.y + r.h);
      perp = rangeOverlap(c.x, c.x + c.w, r.x, r.x + r.w);
    } else if (dir === "down" && r.y >= c.y + c.h - 1e-6) {
      gap = r.y - (c.y + c.h);
      perp = rangeOverlap(c.x, c.x + c.w, r.x, r.x + r.w);
    } else {
      continue;
    }
    const hit = perp > 0 ? 0 : 1;
    if (
      !best ||
      hit < best.hit ||
      (hit === best.hit && gap < best.gap) ||
      (hit === best.hit && gap === best.gap && perp > best.overlap)
    ) {
      best = { id: pane.id, hit, gap, overlap: perp };
    }
  }
  return best?.id ?? null;
}

/** Leaf to focus after closing `leafId` — a neighbor's first leaf. */
export function siblingLeafId(node: LayoutNode, leafId: string): string | null {
  if (node.type === "leaf") return null;
  const index = node.children.findIndex((child) => child.type === "leaf" && child.id === leafId);
  if (index >= 0) {
    const neighbor = node.children[index - 1] ?? node.children[index + 1];
    if (neighbor === undefined) return null;
    return firstLeafId(neighbor);
  }
  for (const child of node.children) {
    const found = siblingLeafId(child, leafId);
    if (found) return found;
  }
  return null;
}

export type PanePlace = "before" | "after";
export type PaneEdge = "left" | "right" | "top" | "bottom";
export type PaneDropZone = PaneEdge | "replace";

type SplitNode = Extract<LayoutNode, { type: "split" }>;

export function paneEdgeFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): PaneEdge {
  if (rect.width <= 0 || rect.height <= 0) return "left";
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const candidates: ReadonlyArray<{ edge: PaneEdge; distance: number }> = [
    { edge: "left", distance: nx },
    { edge: "right", distance: 1 - nx },
    { edge: "top", distance: ny },
    { edge: "bottom", distance: 1 - ny },
  ];
  return candidates.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best,
  ).edge;
}

/** Resolve the split edge or central replace zone for a Pane drop. */

/**
 * Resolve one of the 4 directional edges (left, right, top, bottom) for a Pane drop,
 * with no central replace zone. Suitable for intra-workbench pane repositioning.
 */
export function paneDirectionalZoneFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): PaneEdge {
  if (rect.width <= 0 || rect.height <= 0) return "left";
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;

  if (nx >= 0.42 && nx <= 0.58) {
    return ny < 0.5 ? "top" : "bottom";
  }
  return nx < 0.5 ? "left" : "right";
}

export function paneDropZoneFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): PaneDropZone {
  if (rect.width <= 0 || rect.height <= 0) return "replace";
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const edge = paneEdgeFromPoint(x, y, rect);
  const distance = edge === "left" ? nx : edge === "right" ? 1 - nx : edge === "top" ? ny : 1 - ny;
  return distance < 0.3 ? edge : "replace";
}

function edgeSplit(edge: PaneEdge): { dir: SplitDir; place: PanePlace } {
  if (edge === "left") return { dir: "right", place: "before" };
  if (edge === "right") return { dir: "right", place: "after" };
  if (edge === "top") return { dir: "down", place: "before" };
  return { dir: "down", place: "after" };
}

export function leafParent(
  node: LayoutNode,
  leafId: string,
): { parentId: string; index: number; dir: SplitDir } | null {
  if (node.type === "leaf") return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === undefined) continue;
    if (child.type === "leaf" && child.id === leafId) {
      return { parentId: node.id, index: i, dir: node.dir };
    }
    const found = leafParent(child, leafId);
    if (found) return found;
  }
  return null;
}

function reorderChild(
  split: SplitNode,
  fromIndex: number,
  toIndex: number,
  place: PanePlace,
): SplitNode {
  const n = split.children.length;
  if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n) {
    return split;
  }
  let insertAt = place === "after" ? toIndex + 1 : toIndex;
  insertAt = Math.max(0, Math.min(n, insertAt));
  if (fromIndex < insertAt) insertAt -= 1;
  if (fromIndex === insertAt) return split;
  const children = [...split.children];
  const sizes = [...split.sizes];
  const [child] = children.splice(fromIndex, 1);
  const [size] = sizes.splice(fromIndex, 1);
  if (child === undefined || size === undefined) return split;
  children.splice(insertAt, 0, child);
  sizes.splice(insertAt, 0, size);
  return { ...split, children, sizes };
}

function reorderInSplit(
  node: LayoutNode,
  splitId: string,
  fromIndex: number,
  toIndex: number,
  place: PanePlace,
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return reorderChild(node, fromIndex, toIndex, place);
  return {
    ...node,
    children: node.children.map((child) =>
      reorderInSplit(child, splitId, fromIndex, toIndex, place),
    ),
  };
}

function extractLeaf(
  node: LayoutNode,
  leafId: string,
): {
  tree: LayoutNode | null;
  leaf: Extract<LayoutNode, { type: "leaf" }>;
} | null {
  if (node.type === "leaf") {
    return node.id === leafId ? { tree: null, leaf: node } : null;
  }

  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  let leaf: Extract<LayoutNode, { type: "leaf" }> | null = null;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === undefined) continue;
    const extracted = extractLeaf(child, leafId);
    if (!extracted) {
      children.push(child);
      sizes.push(node.sizes[i] ?? 0);
      continue;
    }
    leaf = extracted.leaf;
    if (extracted.tree) {
      children.push(extracted.tree);
      sizes.push(node.sizes[i] ?? 0);
    }
  }

  if (!leaf) return null;
  if (children.length === 0) return { tree: null, leaf };
  if (children.length === 1) {
    const only = children[0];
    if (only === undefined) return { tree: null, leaf };
    return { tree: only, leaf };
  }
  return {
    tree: { ...node, children, sizes: normalize(sizes) },
    leaf,
  };
}

function insertBeside(
  node: LayoutNode,
  targetId: string,
  incoming: LayoutNode,
  place: PanePlace,
): LayoutNode {
  if (node.type === "leaf") return node;

  const index = node.children.findIndex((child) => child.type === "leaf" && child.id === targetId);
  if (index >= 0) {
    const insertAt = place === "before" ? index : index + 1;
    const children = [...node.children];
    const sizes = [...node.sizes];
    const share = (sizes[index] ?? 0) / 2;
    sizes[index] = share;
    children.splice(insertAt, 0, incoming);
    sizes.splice(insertAt, 0, share);
    return { ...node, children, sizes };
  }

  return {
    ...node,
    children: node.children.map((child) => insertBeside(child, targetId, incoming, place)),
  };
}

function wrapBeside(
  node: LayoutNode,
  targetId: string,
  incoming: LayoutNode,
  dir: SplitDir,
  place: PanePlace,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return {
      type: "split",
      id: cryptoRandomId(),
      dir,
      children: place === "before" ? [incoming, node] : [node, incoming],
      sizes: [0.5, 0.5],
    };
  }
  return {
    ...node,
    children: node.children.map((child) => wrapBeside(child, targetId, incoming, dir, place)),
  };
}

/**
 * Drag a leaf onto another pane's edge. Same-axis siblings keep their
 * sizes and only swap order; a perpendicular edge nests a new split
 * around the target; dropping onto a pane in another group of the
 * same axis relocates the leaf there.
 */
export function movePane(
  node: LayoutNode,
  fromId: string,
  toId: string,
  edge: PaneEdge,
): LayoutNode {
  if (fromId === toId) return node;
  const fromAt = leafParent(node, fromId);
  const toAt = leafParent(node, toId);
  if (!fromAt || !toAt) return node;

  const { dir, place } = edgeSplit(edge);
  if (toAt.dir === dir && fromAt.parentId === toAt.parentId) {
    return reorderInSplit(node, fromAt.parentId, fromAt.index, toAt.index, place);
  }

  const extracted = extractLeaf(node, fromId);
  if (!extracted?.tree) return node;
  if (!leafIds(extracted.tree).includes(toId)) return node;
  const targetAt = leafParent(extracted.tree, toId);
  if (targetAt?.dir === dir) {
    return insertBeside(extracted.tree, toId, extracted.leaf, place);
  }
  return wrapBeside(extracted.tree, toId, extracted.leaf, dir, place);
}

/**
 * Open `leafId` on `toId`'s edge, or move it there when it is
 * already a leaf in this tree.
 */
export function placePane(
  node: LayoutNode,
  leafId: string,
  toId: string,
  edge: PaneEdge,
): LayoutNode {
  if (leafId === toId) return node;
  const ids = leafIds(node);
  if (!ids.includes(toId)) return node;
  if (ids.includes(leafId)) return movePane(node, leafId, toId, edge);

  return placeLayout(node, leaf(leafId), toId, edge);
}

/** Place an intact layout tree beside one pane in another layout. */
export function placeLayout(
  node: LayoutNode,
  incoming: LayoutNode,
  toId: string,
  edge: PaneEdge,
): LayoutNode {
  if (!leafIds(node).includes(toId)) return node;

  const { dir, place } = edgeSplit(edge);
  const targetAt = leafParent(node, toId);
  if (targetAt?.dir === dir) {
    return insertBeside(node, toId, incoming, place);
  }
  return wrapBeside(node, toId, incoming, dir, place);
}

/** Replace one pane with an intact layout tree. */
export function replacePaneWithLayout(
  node: LayoutNode,
  targetId: string,
  incoming: LayoutNode,
): LayoutNode {
  if (node.type === "leaf") return node.id === targetId ? incoming : node;
  return {
    ...node,
    children: node.children.map((child) => replacePaneWithLayout(child, targetId, incoming)),
  };
}

/**
 * Stable UUID generator that works in both the browser and Vitest's Node
 * runtime. We deliberately stay off `globalThis.crypto.randomUUID` here:
 * the Effect-style lint rule prefers the Effect `Crypto` module's
 * `randomUUIDv4`, but the workbench lives outside the Effect runtime, so
 * we use a non-Effect helper with the same surface.
 */
function cryptoRandomId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `id-${stamp}-${random}`;
}
