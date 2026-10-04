/**
 * Stubbing (and un-stubbing) a whole selection at once (#349).
 *
 * The bulk action is deliberately a loop over the single-connection convertEdgeToStubs /
 * collapseStubsForEdge, so the placement math, per-leg metadata split and bundle GC stay
 * one implementation; the tests below assert that equivalence directly rather than
 * re-checking stub geometry. What is genuinely new is the undo behaviour: the batch has to
 * come back in ONE Ctrl+Z, including when the undo history is already at its cap.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fixture from "../testSchematic/schematic.json";
import { selectedConnectionEdges, stubbedLinkIdsOf } from "../stubSelection";
import type { ConnectionEdge, SchematicFile, SchematicNode } from "../types";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key() { return null; }
  get length() { return this.m.size; }
}

let useSchematicStore: typeof import("../store")["useSchematicStore"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore } = await import("../store"));
});

const file = fixture as unknown as SchematicFile;

/** Three routed connections between plain devices — the batch under test. */
const SELECTED = ["edge-1", "edge-3", "edge-5"];

beforeEach(() => {
  // The undo stack is module-global and survives between tests — drain it so the depth
  // assertions below start from a known zero.
  while (useSchematicStore.getState().undoSize > 0) useSchematicStore.getState().undo();
  useSchematicStore.setState({
    nodes: structuredClone(file.nodes) as SchematicNode[],
    edges: (structuredClone(file.edges) as ConnectionEdge[]).map((e) => ({
      ...e,
      selected: SELECTED.includes(e.id),
    })),
  });
});

const state = () => useSchematicStore.getState();
const selectedIds = () => state().edges.filter((e) => e.selected).map((e) => e.id);
const stubLabels = () => state().nodes.filter((n) => n.type === "stub-label");
const linkIds = () =>
  [...new Set(state().edges.map((e) => e.data?.linkedConnectionId).filter(Boolean))];

/**
 * Replace the schematic with `count` routed connections between the fixture's devices,
 * cycling through the fixture's connections for endpoints (repeated endpoints are fine —
 * stubbing keys everything off the connection id). Returns their ids, all selected.
 */
function selectionOfSize(count: number): string[] {
  const base = file.edges as ConnectionEdge[];
  const edges: ConnectionEdge[] = [];
  for (let i = 0; i < count; i++) {
    edges.push({ ...(structuredClone(base[i % base.length]) as ConnectionEdge), id: `bulk-${i}`, selected: true });
  }
  useSchematicStore.setState({ nodes: structuredClone(file.nodes) as SchematicNode[], edges });
  return edges.map((e) => e.id);
}

/** Selecting the given connections, replacing whatever was selected before. */
function select(ids: string[]) {
  useSchematicStore.setState({
    edges: state().edges.map((e) => ({ ...e, selected: ids.includes(e.id) })),
  });
}

/** Nodes + edges with the run-dependent linked-connection UUIDs flattened in order of
 *  appearance, so two routes to the same conversion compare equal. Connection `selected`
 *  and `zIndex` are dropped too — undo restores neither. */
function normalized(): string {
  let out = JSON.stringify({
    nodes: state().nodes,
    edges: state().edges.map(({ selected: _s, zIndex: _z, ...rest }) => rest),
  });
  let i = 0;
  for (const id of linkIds()) out = out.split(id!).join(`LINK-${i++}`);
  return out;
}

/**
 * Fill the session's undo history to its cap. pushUndo holds the stack at MAX_HISTORY by
 * pushing and then shifting, so from here on a push leaves the length unchanged — the
 * boundary at which a length-based "did it push?" test stops working.
 */
function saturateUndoHistory(): number {
  let previous = -1;
  for (let i = 0; i < 500; i++) {
    state().pushSnapshot();
    const size = state().undoSize;
    if (size === previous) return size;
    previous = size;
  }
  throw new Error("undo history never reached its cap");
}

/** MAX_HISTORY isn't exported — measure it, then leave the history empty again. */
function undoHistoryCap(): number {
  const cap = saturateUndoHistory();
  while (state().undoSize > 0) state().undo();
  return cap;
}

describe("bulk stub of a selection (#349)", () => {
  it("stubs every selected connection", () => {
    const edgesBefore = state().edges.length;

    state().convertEdgesToStubs(selectedIds());

    expect(linkIds()).toHaveLength(SELECTED.length);
    expect(stubLabels()).toHaveLength(SELECTED.length * 2);
    // Each connection became two legs, and none of the originals survived.
    expect(state().edges).toHaveLength(edgesBefore + SELECTED.length);
    for (const id of SELECTED) {
      expect(state().edges.find((e) => e.id === id)).toBeUndefined();
      expect(state().edges.find((e) => e.id === `${id}-src`)?.data?.linkedConnectionId).toBeTruthy();
      expect(state().edges.find((e) => e.id === `${id}-tgt`)?.data?.linkedConnectionId).toBeTruthy();
    }
  });

  it("produces exactly the state stubbing them one at a time produces", () => {
    for (const id of SELECTED) state().convertEdgeToStubs(id);
    const oneByOne = normalized();

    useSchematicStore.setState({
      nodes: structuredClone(file.nodes) as SchematicNode[],
      edges: structuredClone(file.edges) as ConnectionEdge[],
    });
    state().convertEdgesToStubs(SELECTED);

    expect(normalized()).toBe(oneByOne);
  });

  it("takes one undo back to every connection unstubbed", () => {
    const edgeIdsBefore = state().edges.map((e) => e.id).sort();
    const nodesBefore = state().nodes.length;
    const undoBefore = state().undoSize;

    state().convertEdgesToStubs(selectedIds());
    expect(state().undoSize).toBe(undoBefore + 1);

    state().undo();

    expect(state().edges.map((e) => e.id).sort()).toEqual(edgeIdsBefore);
    expect(state().nodes).toHaveLength(nodesBefore);
    expect(stubLabels()).toHaveLength(0);
    expect(linkIds()).toHaveLength(0);
    expect(state().undoSize).toBe(undoBefore);
  });

  it("still takes one undo, and evicts no older step, when the history is at its cap", () => {
    // A capped stack absorbs a push by dropping its OLDEST entry, so per-connection
    // pushes that the batch means to throw away still cost real undo steps: a batch of
    // N would silently destroy N-1 of the session's earlier steps.
    const cap = saturateUndoHistory();
    const edgeIdsBefore = state().edges.map((e) => e.id).sort();

    state().convertEdgesToStubs(selectedIds());
    expect(state().undoSize).toBe(cap);

    state().undo();

    expect(state().edges.map((e) => e.id).sort()).toEqual(edgeIdsBefore);
    expect(stubLabels()).toHaveLength(0);
    expect(linkIds()).toHaveLength(0);
    expect(state().undoSize).toBe(cap - 1);
  });

  it("takes one undo for a batch larger than the whole undo history", () => {
    // The case the feature is named for — Ctrl+A, then stub everything. Per-connection
    // pushes would shift the batch's own pre-loop entry off the bottom of the stack once
    // the batch outgrew MAX_HISTORY, leaving the restubbed schematic with nothing to undo.
    const cap = undoHistoryCap();
    const ids = selectionOfSize(cap + 1);
    const undoBefore = state().undoSize;

    state().convertEdgesToStubs(ids);

    expect(linkIds()).toHaveLength(ids.length);
    expect(stubLabels()).toHaveLength(ids.length * 2);
    expect(state().undoSize).toBe(undoBefore + 1);

    state().undo();

    expect(state().edges.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(stubLabels()).toHaveLength(0);
    expect(linkIds()).toHaveLength(0);
    expect(state().undoSize).toBe(undoBefore);
  });

  it("takes one undo back to the bundle a stubbed member was pulled out of", () => {
    // The one place the bulk path isn't a pure loop: stubbing a member can dissolve its
    // bundle, so the batch's snapshot has to carry bundles as well as devices/connections.
    state().createBundle(["edge-1", "edge-3"]);
    const bundleId = state().edges.find((e) => e.id === "edge-1")!.data!.bundleId;
    expect(bundleId).toBeTruthy();
    const undoBefore = state().undoSize;

    state().convertEdgesToStubs(["edge-1", "edge-3"]);

    expect(state().bundles[bundleId!]).toBeUndefined();
    expect(state().undoSize).toBe(undoBefore + 1);

    state().undo();

    expect(state().bundles[bundleId!]).toBeTruthy();
    expect(state().edges.find((e) => e.id === "edge-1")?.data?.bundleId).toBe(bundleId);
    expect(state().edges.find((e) => e.id === "edge-3")?.data?.bundleId).toBe(bundleId);
    expect(linkIds()).toHaveLength(0);
  });

  it("leaves already-stubbed connections exactly as they are", () => {
    state().convertEdgeToStubs("edge-1");
    const alreadyStubbed = state()
      .edges.filter((e) => e.data?.linkedConnectionId)
      .map((e) => JSON.stringify({ ...e, selected: undefined }))
      .sort();
    const undoBefore = state().undoSize;

    // Both legs of the stubbed connection are selected alongside two routed ones.
    select([...state().edges.filter((e) => e.data?.linkedConnectionId).map((e) => e.id), "edge-3", "edge-5"]);
    state().convertEdgesToStubs(selectedIds());

    expect(linkIds()).toHaveLength(3);
    const after = state()
      .edges.filter((e) => alreadyStubbed.includes(JSON.stringify({ ...e, selected: undefined })))
      .map((e) => JSON.stringify({ ...e, selected: undefined }))
      .sort();
    expect(after).toEqual(alreadyStubbed);
    // The skipped legs must not have cost an extra undo entry either.
    expect(state().undoSize).toBe(undoBefore + 1);
  });

  it("does nothing, and pushes no undo entry, when every selected connection is stubbed", () => {
    state().convertEdgesToStubs(selectedIds());
    const before = normalized();
    const undoBefore = state().undoSize;

    state().convertEdgesToStubs(state().edges.filter((e) => e.data?.linkedConnectionId).map((e) => e.id));

    expect(normalized()).toBe(before);
    expect(state().undoSize).toBe(undoBefore);
  });
});

describe("bulk show-in-full of a selection (#349)", () => {
  beforeEach(() => {
    state().convertEdgesToStubs(SELECTED);
    // Stubbing carries `selected` onto both legs, which is the selection the menu acts on.
    expect(selectedIds()).toHaveLength(SELECTED.length * 2);
  });

  it("collapses every selected stubbed connection once, from either leg", () => {
    state().collapseStubsForEdges(selectedIds());

    expect(linkIds()).toHaveLength(0);
    expect(stubLabels()).toHaveLength(0);
    expect(state().edges).toHaveLength(file.edges.length);
    for (const id of SELECTED) expect(state().edges.find((e) => e.id === id)).toBeTruthy();
  });

  it("takes one undo back to every connection stubbed again", () => {
    const stubbed = normalized();
    const undoBefore = state().undoSize;

    state().collapseStubsForEdges(selectedIds());
    expect(state().undoSize).toBe(undoBefore + 1);

    state().undo();

    expect(linkIds()).toHaveLength(SELECTED.length);
    expect(stubLabels()).toHaveLength(SELECTED.length * 2);
    expect(normalized()).toBe(stubbed);
  });

  it("ignores selected connections that aren't stubbed", () => {
    select([...state().edges.filter((e) => e.data?.linkedConnectionId).map((e) => e.id), "edge-2"]);
    const routed = JSON.stringify({ ...state().edges.find((e) => e.id === "edge-2")!, selected: undefined });

    state().collapseStubsForEdges(selectedIds());

    expect(linkIds()).toHaveLength(0);
    expect(
      JSON.stringify({ ...state().edges.find((e) => e.id === "edge-2")!, selected: undefined }),
    ).toBe(routed);
  });
});

/**
 * A stub's legs are hairline segments; its tag is the only part big enough to marquee or
 * click, and the selection bar's "keep only stubs" filter deselects every connection
 * outright. So the bulk surfaces resolve the selection through the tags — otherwise a
 * screen full of selected stubs reports zero connections and offers no unstub at all.
 *
 * These exercise the resolver the menus and the edit panel share, composed with the same
 * collapseStubsForEdges the single-connection path uses.
 */
describe("stub tags stand in for their connection in a selection (#349)", () => {
  /** Select nothing but stub tags — what the "keep only stubs" filter leaves behind. */
  function selectTagsOnly(predicate: (n: SchematicNode) => boolean = () => true) {
    useSchematicStore.setState({
      nodes: state().nodes.map((n) => ({
        ...n,
        selected: n.type === "stub-label" && predicate(n),
      })),
      edges: state().edges.map((e) => ({ ...e, selected: false })),
    });
  }

  const resolved = () => selectedConnectionEdges(state().nodes, state().edges);

  beforeEach(() => {
    state().convertEdgesToStubs(SELECTED);
  });

  it("resolves a tags-only selection to both legs of every tagged connection", () => {
    selectTagsOnly();
    expect(selectedIds()).toHaveLength(0); // nothing is selected as a connection

    expect(resolved()).toHaveLength(SELECTED.length * 2);
    expect(stubbedLinkIdsOf(resolved())).toHaveLength(SELECTED.length);
  });

  it("counts a connection whose source-side tag alone is selected", () => {
    // A marquee down one column catches one tag per connection, not the pair.
    selectTagsOnly((n) => (n.data as { side?: string }).side === "source");

    expect(stubbedLinkIdsOf(resolved())).toHaveLength(SELECTED.length);
    // Both legs still come along — the pair is one logical cable.
    expect(resolved()).toHaveLength(SELECTED.length * 2);
  });

  it("unstubs every tag-selected connection in one undo step", () => {
    selectTagsOnly();
    const stubbed = normalized(); // after selecting: normalized() keeps node `selected`
    const undoBefore = state().undoSize;

    state().collapseStubsForEdges(resolved().map((e) => e.id));

    expect(linkIds()).toHaveLength(0);
    expect(stubLabels()).toHaveLength(0);
    for (const id of SELECTED) expect(state().edges.find((e) => e.id === id)).toBeTruthy();
    expect(state().undoSize).toBe(undoBefore + 1);

    state().undo();
    expect(normalized()).toBe(stubbed);
  });

  it("leaves routed connections alone in a mixed tag + connection selection", () => {
    // Tags of two stubbed connections, plus one routed connection selected outright.
    const oneSideStubs = new Set(
      state()
        .nodes.filter((n) => n.type === "stub-label")
        .filter((n) => ["edge-1", "edge-3"].some((id) => n.id.startsWith(`stub-${id}-`)))
        .map((n) => n.id),
    );
    useSchematicStore.setState({
      nodes: state().nodes.map((n) => ({ ...n, selected: oneSideStubs.has(n.id) })),
      edges: state().edges.map((e) => ({ ...e, selected: e.id === "edge-2" })),
    });
    const routed = JSON.stringify({ ...state().edges.find((e) => e.id === "edge-2")!, selected: undefined });
    const untouched = normalizedStubsOf("edge-5");

    state().collapseStubsForEdges(resolved().map((e) => e.id));

    // The two tagged connections came back; the routed one and the untagged stub didn't move.
    expect(state().edges.find((e) => e.id === "edge-1")).toBeTruthy();
    expect(state().edges.find((e) => e.id === "edge-3")).toBeTruthy();
    expect(
      JSON.stringify({ ...state().edges.find((e) => e.id === "edge-2")!, selected: undefined }),
    ).toBe(routed);
    expect(normalizedStubsOf("edge-5")).toBe(untouched);
  });

  it("stubs only the routed connections of a mixed tag + connection selection", () => {
    useSchematicStore.setState({
      nodes: state().nodes.map((n) => ({ ...n, selected: n.type === "stub-label" })),
      edges: state().edges.map((e) => ({ ...e, selected: e.id === "edge-2" })),
    });
    const undoBefore = state().undoSize;

    state().convertEdgesToStubs(resolved().map((e) => e.id));

    // The three already-stubbed connections stayed stubbed; only edge-2 was converted.
    expect(linkIds()).toHaveLength(SELECTED.length + 1);
    expect(state().edges.find((e) => e.id === "edge-2")).toBeUndefined();
    expect(state().undoSize).toBe(undoBefore + 1);
  });
});

/** The legs and tags of one originally-routed connection, for "did this move?" comparisons. */
function normalizedStubsOf(originalEdgeId: string): string {
  return JSON.stringify({
    edges: state()
      .edges.filter((e) => e.id.startsWith(`${originalEdgeId}-`))
      .map(({ selected: _s, ...rest }) => rest),
    nodes: state()
      .nodes.filter((n) => n.id.startsWith(`stub-${originalEdgeId}-`))
      .map(({ selected: _s, ...rest }) => rest),
  });
}
