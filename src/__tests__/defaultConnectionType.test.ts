/**
 * The default connection type (#353).
 *
 * Drawing a connection normally leaves a routed wire; with the default set to "stub"
 * the same gesture has to land on the state the right-click ▸ Stub Connection action
 * produces, not on a hand-rolled imitation of it. The equality test below is the point
 * of the feature — it fails the moment onConnect starts building stub state itself.
 *
 * Driven through the store's real `onConnect` over the seeded test fixture (#307), so
 * the ports carry the connector/signal shapes the app actually validates.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fixture from "../testSchematic/schematic.json";
import type { ConnectionEdge, SchematicFile, SchematicNode, StubLabelData } from "../types";

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

/** Combo Jack Box ▸ XLR out → Powered Speaker ▸ XLR in. Both ends are unwired in the
 *  fixture and agree on signal type and connector, so no adapter dialog intercepts. */
const CONNECTION = {
  source: "device-16",
  sourceHandle: "combo-xlr-out",
  target: "device-12",
  targetHandle: "spk-xlr-in",
};

/** Combo Jack Box ▸ TS out → Amp ▸ XLR in. Same signal, mismatched connectors, so
 *  onConnect stops at the incompatible-connection prompt instead of wiring it. */
const MISMATCHED = {
  source: "device-16",
  sourceHandle: "combo-ts-out",
  target: "device-6",
  targetHandle: "amp-xlr-in-2",
};

const file = fixture as unknown as SchematicFile;

beforeEach(() => {
  useSchematicStore.setState({
    nodes: structuredClone(file.nodes) as SchematicNode[],
    edges: structuredClone(file.edges) as ConnectionEdge[],
    defaultConnectionType: "wire",
    pendingIncompatibleConnection: null,
  });
});

const FIXTURE_EDGE_IDS = new Set((file.edges as ConnectionEdge[]).map((e) => e.id));

/** Nodes + edges with the two run-dependent ids flattened — the linked-connection UUID
 *  and the allocated edge number, which keeps counting up across runs in one session —
 *  so two runs of the same conversion compare equal. */
function normalized() {
  const state = useSchematicStore.getState();
  let out = JSON.stringify({ nodes: state.nodes, edges: state.edges });
  const links = new Set<string>();
  const bases = new Set<string>();
  for (const e of state.edges) {
    if (e.data?.linkedConnectionId) links.add(e.data.linkedConnectionId);
    const base = e.id.replace(/-(src|tgt)$/, "");
    if (!FIXTURE_EDGE_IDS.has(base)) bases.add(base);
  }
  let i = 0;
  for (const id of links) out = out.split(id).join(`LINK-${i++}`);
  for (const base of bases) out = out.replace(new RegExp(`${base}(?!\\d)`, "g"), "EDGE-NEW");
  return out;
}

function newEdges(before: Set<string>): ConnectionEdge[] {
  return useSchematicStore.getState().edges.filter((e) => !before.has(e.id));
}

/** The two stub labels belonging to one logical connection, source leg first. */
function stubsFor(linkedConnectionId: string): SchematicNode[] {
  return useSchematicStore
    .getState()
    .nodes.filter(
      (n) => n.type === "stub-label" && (n.data as StubLabelData).linkedConnectionId === linkedConnectionId,
    );
}

/**
 * Fill the session's undo history to its cap. pushUndo holds the stack at MAX_HISTORY
 * by pushing and then shifting, so from here on a push leaves the length unchanged —
 * the boundary at which a length-based "did it push?" test stops working. Detected
 * through the store's own undoSize rather than the module-private constant.
 */
function saturateUndoHistory(): number {
  let previous = -1;
  for (let i = 0; i < 500; i++) {
    useSchematicStore.getState().pushSnapshot();
    const size = useSchematicStore.getState().undoSize;
    if (size === previous) return size;
    previous = size;
  }
  throw new Error("undo history never reached its cap");
}

describe("default connection type (#353)", () => {
  it("draws a plain wire by default", () => {
    const before = new Set(useSchematicStore.getState().edges.map((e) => e.id));
    const stubsBefore = useSchematicStore.getState().nodes.filter((n) => n.type === "stub-label").length;

    useSchematicStore.getState().onConnect(CONNECTION);

    const added = newEdges(before);
    expect(added).toHaveLength(1);
    expect(added[0].data?.linkedConnectionId).toBeUndefined();
    expect(added[0].source).toBe("device-16");
    expect(added[0].target).toBe("device-12");
    expect(useSchematicStore.getState().nodes.filter((n) => n.type === "stub-label")).toHaveLength(stubsBefore);
  });

  it("creates the connection already stubbed when the default is stub", () => {
    const before = new Set(useSchematicStore.getState().edges.map((e) => e.id));
    const stubsBefore = useSchematicStore.getState().nodes.filter((n) => n.type === "stub-label").length;

    useSchematicStore.setState({ defaultConnectionType: "stub" });
    useSchematicStore.getState().onConnect(CONNECTION);

    const added = newEdges(before);
    expect(added).toHaveLength(2);
    const linkIds = new Set(added.map((e) => e.data?.linkedConnectionId));
    expect(linkIds.size).toBe(1);
    const linkId = [...linkIds][0];
    expect(linkId).toBeTruthy();

    expect(useSchematicStore.getState().nodes.filter((n) => n.type === "stub-label")).toHaveLength(stubsBefore + 2);
    const sides = stubsFor(linkId!).map((n) => (n.data as StubLabelData).side).sort();
    expect(sides).toEqual(["source", "target"]);
  });

  it("produces exactly the state a manual convert-to-stub produces", () => {
    // Wire it, then stub it by hand — the right-click path.
    useSchematicStore.getState().onConnect(CONNECTION);
    const wired = useSchematicStore.getState().edges.at(-1)!;
    useSchematicStore.getState().convertEdgeToStubs(wired.id);
    const manual = normalized();

    // Same gesture with the default set to stub.
    useSchematicStore.setState({
      nodes: structuredClone(file.nodes) as SchematicNode[],
      edges: structuredClone(file.edges) as ConnectionEdge[],
      defaultConnectionType: "stub",
    });
    useSchematicStore.getState().onConnect(CONNECTION);

    expect(normalized()).toBe(manual);
  });

  it("takes one undo back to before the connection existed", () => {
    const edgesBefore = useSchematicStore.getState().edges.length;
    const nodesBefore = useSchematicStore.getState().nodes.length;

    useSchematicStore.setState({ defaultConnectionType: "stub" });
    useSchematicStore.getState().onConnect(CONNECTION);
    expect(useSchematicStore.getState().edges).toHaveLength(edgesBefore + 2);

    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().edges).toHaveLength(edgesBefore);
    expect(useSchematicStore.getState().nodes).toHaveLength(nodesBefore);
  });

  it("still takes one undo when the undo history is already at its cap", () => {
    const capped = saturateUndoHistory();
    const edgesBefore = useSchematicStore.getState().edges.length;
    const nodesBefore = useSchematicStore.getState().nodes.length;

    useSchematicStore.setState({ defaultConnectionType: "stub" });
    useSchematicStore.getState().onConnect(CONNECTION);
    expect(useSchematicStore.getState().edges).toHaveLength(edgesBefore + 2);
    const depthAfterConnect = useSchematicStore.getState().undoSize;

    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().edges).toHaveLength(edgesBefore);
    expect(useSchematicStore.getState().nodes).toHaveLength(nodesBefore);
    // A capped stack absorbs both pushes without growing, so the intermediate entry
    // has to be spotted some other way than the depth.
    expect(depthAfterConnect).toBe(capped - 1);
  });

  it("stubs a connection forced through the incompatible-connector prompt", () => {
    const before = new Set(useSchematicStore.getState().edges.map((e) => e.id));
    useSchematicStore.setState({ defaultConnectionType: "stub" });

    useSchematicStore.getState().onConnect(MISMATCHED);
    expect(newEdges(before)).toHaveLength(0);
    expect(useSchematicStore.getState().pendingIncompatibleConnection).toBeTruthy();

    useSchematicStore.getState().forceIncompatibleConnection();

    const added = newEdges(before);
    expect(added).toHaveLength(2);
    expect(added.every((e) => e.data?.allowIncompatible)).toBe(true);
    const linkIds = new Set(added.map((e) => e.data?.linkedConnectionId));
    expect(linkIds.size).toBe(1);
    expect(stubsFor([...linkIds][0]!)).toHaveLength(2);
  });

  it("leaves existing connections alone when the default changes", () => {
    // Seed one already-stubbed connection alongside the fixture's routed wires, so the
    // setting change has both kinds of existing connection to leave untouched.
    useSchematicStore.getState().onConnect(CONNECTION);
    useSchematicStore.getState().convertEdgeToStubs(useSchematicStore.getState().edges.at(-1)!.id);
    expect(useSchematicStore.getState().nodes.filter((n) => n.type === "stub-label")).toHaveLength(2);
    const before = JSON.stringify({
      nodes: useSchematicStore.getState().nodes,
      edges: useSchematicStore.getState().edges,
    });

    useSchematicStore.getState().setDefaultConnectionType("stub");

    expect(JSON.stringify({
      nodes: useSchematicStore.getState().nodes,
      edges: useSchematicStore.getState().edges,
    })).toBe(before);
  });
});
