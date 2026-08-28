/**
 * lib/graph-layout.ts — layered left-to-right auto-layout for the builder canvas.
 *
 * Pure and structural: it takes ids and edges, returns positions. It never sees
 * a React Flow node, so every rule below is asserted in vitest rather than
 * eyeballed on a canvas.
 *
 * Why hand-written rather than dagre/elk: the graphs this product authors are
 * 5–15 nodes, mostly a spine with one or two branches, and they are already
 * validated acyclic before publish. Layering plus a barycentre ordering pass and
 * a median coordinate pass produces the same picture dagre would for that shape,
 * at ~200 lines and no dependency — the same call already made for the WebGL
 * landing scene (no three.js for one quad) and the animated nav icons (no new
 * motion library). If real graphs ever show crossings this cannot resolve, THIS
 * is the one file to swap for `@dagrejs/dagre`; nothing else knows how layout
 * works.
 *
 * It is Sugiyama's three phases, in the usual order:
 *
 *   1. **Layer** — longest path from a source, so a node always sits to the
 *      right of every predecessor that can reach it.
 *   2. **Order** — barycentre sweeps within each layer to shorten edges and cut
 *      crossings. Edges spanning more than one layer get invisible dummy nodes
 *      first, so a skip edge takes part in ordering and is routed AROUND the
 *      cards it passes rather than straight through them. On the seeded invoice
 *      graph that is the difference between the approval gate sitting off the
 *      spine (right) and the `check_amount -> post_to_erp` bypass being drawn
 *      through the approval card (wrong).
 *   3. **Position** — alternating forward/backward median passes, each layer
 *      re-centred on what its neighbours wanted, so a chain comes out as a
 *      straight horizontal line.
 *
 * Two properties the canvas depends on:
 *
 * - **It terminates on a cyclic graph.** The canvas holds invalid drafts all the
 *   time — `validateGraph`'s `cycle` rule is a publish-time concern, and Tidy up
 *   has to work while the user is mid-construction. Layering is Kahn's algorithm
 *   and whatever the cycle strands is appended afterwards, never recursed into.
 * - **It is deterministic.** Same graph in, same positions out. An unstable
 *   layout would make every Tidy up a fresh autosave.
 */

export type LayoutNode = { id: string };
export type LayoutEdge = { source: string; target: string };

export type LayoutPositions = Record<string, { x: number; y: number }>;

export type LayoutOptions = {
  /** Horizontal distance between one layer and the next. */
  rankSpacing?: number;
  /** Minimum vertical distance between two nodes sharing a layer. */
  nodeSpacing?: number;
  originX?: number;
  originY?: number;
};

/** Node card is `min-w-[190px]` and ~54px tall; these leave a comfortable gutter. */
const DEFAULT_RANK_SPACING = 300;
const DEFAULT_NODE_SPACING = 110;

/** Ordering sweeps, then coordinate sweeps. Both are well past convergence at this size. */
const ORDERING_PASSES = 4;
const POSITION_PASSES = 4;

/**
 * Dummy ids for long-edge routing. A real node key matches `^[a-z][a-z0-9_]*$`
 * (`lib/node-rename.ts`), so a NUL prefix cannot collide with one.
 */
const DUMMY_PREFIX = "\u0000long:";

/** Assign every node an (x, y) on a left-to-right layered grid. */
export function layoutGraph(
  graph: { nodes: readonly LayoutNode[]; edges: readonly LayoutEdge[] },
  options: LayoutOptions = {},
): LayoutPositions {
  const {
    rankSpacing = DEFAULT_RANK_SPACING,
    nodeSpacing = DEFAULT_NODE_SPACING,
    originX = 0,
    originY = 0,
  } = options;

  const ids = graph.nodes.map((node) => node.id);
  if (ids.length === 0) return {};

  const known = new Set(ids);
  // Self-loops and edges to nodes that are not on the canvas would corrupt the
  // in-degree count and strand everything; `dangling_edge` reports them, layout
  // just ignores them.
  const edges = graph.edges.filter(
    (edge) => edge.source !== edge.target && known.has(edge.source) && known.has(edge.target),
  );

  const layers = assignLayers(ids, edges);
  const expanded = insertDummies(ids, edges, layers);
  const order = orderWithinLayers(expanded.ids, expanded.edges, expanded.layers);
  const ys = assignCoordinates(order, expanded.edges, nodeSpacing);

  // Normalise against the REAL nodes only, so dummy routing never shifts the
  // visible graph off the origin the caller asked for.
  const realYs = ids.map((id) => ys.get(id)!);
  const shift = originY - Math.min(...realYs);

  const positions: LayoutPositions = {};
  for (const id of ids) {
    positions[id] = {
      x: originX + layers.get(id)! * rankSpacing,
      y: Math.round(ys.get(id)! + shift),
    };
  }
  return positions;
}

/**
 * Longest-path layering via Kahn's algorithm.
 *
 * Anything still holding an in-degree when the queue drains is inside a cycle.
 * Those are placed one layer past whichever predecessors *did* resolve, in
 * stable array order — good enough to draw, and it cannot loop.
 */
function assignLayers(ids: readonly string[], edges: readonly LayoutEdge[]): Map<string, number> {
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const edge of edges) {
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
    inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
  }

  const layer = new Map<string, number>();
  // Seeded in array order so the result never depends on Set iteration order.
  const queue = ids.filter((id) => inDegree.get(id) === 0);
  for (const id of queue) layer.set(id, 0);

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const currentLayer = layer.get(current)!;
    for (const next of outgoing.get(current)!) {
      layer.set(next, Math.max(layer.get(next) ?? 0, currentLayer + 1));
      const remaining = inDegree.get(next)! - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  for (const id of ids) {
    if (layer.has(id)) continue;
    const resolved = incoming.get(id)!.filter((source) => layer.has(source));
    const deepest = resolved.reduce((best, source) => Math.max(best, layer.get(source)!), -1);
    layer.set(id, deepest + 1);
  }

  return layer;
}

/**
 * Replace every edge spanning more than one layer with a chain through
 * invisible per-layer dummies, so the ordering and coordinate passes reserve
 * room for it instead of letting it cut through the cards in between.
 */
function insertDummies(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  layers: Map<string, number>,
): { ids: string[]; edges: LayoutEdge[]; layers: Map<string, number> } {
  const nextIds = [...ids];
  const nextEdges: LayoutEdge[] = [];
  const nextLayers = new Map(layers);
  let counter = 0;

  for (const edge of edges) {
    const from = layers.get(edge.source)!;
    const to = layers.get(edge.target)!;
    if (to - from <= 1) {
      nextEdges.push(edge);
      continue;
    }

    let previous = edge.source;
    for (let layer = from + 1; layer < to; layer += 1) {
      const dummy = `${DUMMY_PREFIX}${counter}`;
      counter += 1;
      nextIds.push(dummy);
      nextLayers.set(dummy, layer);
      nextEdges.push({ source: previous, target: dummy });
      previous = dummy;
    }
    nextEdges.push({ source: previous, target: edge.target });
  }

  return { ids: nextIds, edges: nextEdges, layers: nextLayers };
}

/**
 * Barycentre ordering: sweep forward reading predecessors, then back reading
 * successors, repeatedly. A node with no neighbour in the reference layer keeps
 * its current index, so an isolated node does not drift to the top on every pass.
 */
function orderWithinLayers(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  layers: Map<string, number>,
): string[][] {
  const depth = Math.max(...ids.map((id) => layers.get(id)!)) + 1;
  const buckets: string[][] = Array.from({ length: depth }, () => []);
  for (const id of ids) buckets[layers.get(id)!].push(id);

  const { predecessors, successors } = adjacency(ids, edges);

  for (let pass = 0; pass < ORDERING_PASSES; pass += 1) {
    const forward = pass % 2 === 0;
    for (const index of sweepRange(depth, forward)) {
      const reference = indexMap(buckets[forward ? index - 1 : index + 1]);
      sortByBarycentre(buckets[index], reference, forward ? predecessors : successors);
    }
  }

  return buckets;
}

/**
 * Median coordinate assignment.
 *
 * Each pass gives every node the mean of its neighbours' positions in the
 * adjacent layer, then pushes the layer apart to honour `nodeSpacing` in the
 * order phase 2 fixed, then re-centres the layer on what its neighbours wanted.
 * That last step is load-bearing: pushing apart only ever moves nodes DOWN, so
 * without the re-centre the whole graph drifts further down on every pass and
 * never converges.
 */
function assignCoordinates(
  order: readonly (readonly string[])[],
  edges: readonly LayoutEdge[],
  nodeSpacing: number,
): Map<string, number> {
  const ids = order.flat();
  const { predecessors, successors } = adjacency(ids, edges);

  const y = new Map<string, number>();
  for (const bucket of order) bucket.forEach((id, index) => y.set(id, index * nodeSpacing));

  for (let pass = 0; pass < POSITION_PASSES; pass += 1) {
    const forward = pass % 2 === 0;
    for (const index of sweepRange(order.length, forward)) {
      relaxLayer(order[index], forward ? predecessors : successors, y, nodeSpacing);
    }
  }

  return y;
}

function relaxLayer(
  bucket: readonly string[],
  neighbours: Map<string, string[]>,
  y: Map<string, number>,
  nodeSpacing: number,
): void {
  if (bucket.length === 0) return;

  const desired = bucket.map((id) => {
    const positions = neighbours.get(id)!.map((neighbour) => y.get(neighbour)!);
    return positions.length === 0 ? y.get(id)! : mean(positions);
  });

  const resolved: number[] = [];
  for (let index = 0; index < bucket.length; index += 1) {
    resolved.push(index === 0 ? desired[0] : Math.max(desired[index], resolved[index - 1] + nodeSpacing));
  }

  const shift = mean(desired) - mean(resolved);
  bucket.forEach((id, index) => y.set(id, resolved[index] + shift));
}

/** Layer indices to visit: 1..n-1 going forward, n-2..0 coming back. */
function sweepRange(depth: number, forward: boolean): number[] {
  return Array.from({ length: depth - 1 }, (_, index) => (forward ? index + 1 : depth - 2 - index));
}

function adjacency(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): { predecessors: Map<string, string[]>; successors: Map<string, string[]> } {
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    predecessors.get(edge.target)!.push(edge.source);
    successors.get(edge.source)!.push(edge.target);
  }
  return { predecessors, successors };
}

function indexMap(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]));
}

function sortByBarycentre(
  bucket: string[],
  reference: Map<string, number>,
  neighbours: Map<string, string[]>,
): void {
  const current = indexMap(bucket);
  const weight = new Map<string, number>();

  for (const id of bucket) {
    const positions = neighbours
      .get(id)!
      .map((neighbour) => reference.get(neighbour))
      .filter((index): index is number => index !== undefined);
    // No neighbour in the reference layer — hold position rather than sorting to
    // the front, which would shuffle unattached nodes on every pass.
    weight.set(id, positions.length === 0 ? current.get(id)! : mean(positions));
  }

  bucket.sort((a, b) => {
    const delta = weight.get(a)! - weight.get(b)!;
    // Stable tiebreak on the incoming order, so equal barycentres never flip.
    return delta !== 0 ? delta : current.get(a)! - current.get(b)!;
  });
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Does this graph look like it was arranged for the old top-to-bottom canvas?
 *
 * Used only to *suggest* Tidy up — nothing re-lays a graph out on its own.
 * Auto-layout on open would move every node, which the autosave hook reads as an
 * edit; on a published version that silently creates version N+1 byte-identical
 * to N, which is a bug this codebase has already shipped once and documented.
 */
export function looksVertical(
  nodes: readonly { id: string; position: { x: number; y: number } }[],
  tolerance = 120,
): boolean {
  if (nodes.length < 3) return false;
  const xs = nodes.map((node) => node.position.x);
  const ys = nodes.map((node) => node.position.y);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  return spreadX <= tolerance && spreadY > tolerance;
}
