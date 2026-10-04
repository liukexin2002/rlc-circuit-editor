/**
 * Bare undoStack.pop() sites would corrupt the undo stack inside a suppressed bulk-undo
 * batch (#365).
 *
 * runAsSingleUndoStep (#349) suppresses per-item pushUndo calls to a counter instead of the
 * real stack, so the whole batch lands as one entry. Four call sites unwind a failed action
 * with `undoStack.pop()`; inside a suppressed batch that would pop an unrelated pre-batch
 * entry off the real stack rather than the (never-pushed) suppressed one. undoFailedPush()
 * is the fix: it routes the unwind through whichever bookkeeping the matching pushUndo
 * actually did.
 *
 * __undoBatchInternalsForTest exposes runAsSingleUndoStep and undoFailedPush directly so the
 * scenario can be driven without waiting for a real bulk action that fails mid-batch.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { ConnectionEdge, SchematicFile, SchematicNode } from "../types";
import fixture from "../testSchematic/schematic.json";

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
let __undoBatchInternalsForTest: typeof import("../store")["__undoBatchInternalsForTest"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore, __undoBatchInternalsForTest } = await import("../store"));
});

const file = fixture as unknown as SchematicFile;
const state = () => useSchematicStore.getState();

beforeEach(() => {
  // The undo stack is module-global and survives between tests — drain it so each test
  // starts from a known-empty history.
  while (state().undoSize > 0) state().undo();
  useSchematicStore.setState({
    nodes: structuredClone(file.nodes) as SchematicNode[],
    edges: structuredClone(file.edges) as ConnectionEdge[],
  });
});

describe("undoFailedPush inside a suppressed bulk-undo batch (#365)", () => {
  it("unwinds a failed item without touching the real stack, leaving pre-batch entries intact", () => {
    // Two ordinary pre-batch undo entries, each with a distinguishable device count so we
    // can tell them apart on the way back out.
    state().pushSnapshot(); // pre-batch entry A, over the fixture's node count
    useSchematicStore.setState({ nodes: [...state().nodes, state().nodes[0]] });
    state().pushSnapshot(); // pre-batch entry B, one device heavier than A
    const undoBeforeBatch = state().undoSize;
    expect(undoBeforeBatch).toBe(2);

    // A batch of two items: the first pushes and then discovers a failure and unwinds
    // (mirroring insertAdapterBetween / resolveIncompatibleConnection's fail-and-pop sites);
    // the second succeeds and stays pushed.
    const order: string[] = [];
    __undoBatchInternalsForTest.runAsSingleUndoStep(["will-fail", "will-succeed"], (id) => {
      order.push(id);
      state().pushSnapshot(); // suppressed: only bumps the batch counter, the real stack is untouched
      if (id === "will-fail") {
        __undoBatchInternalsForTest.undoFailedPush(); // unwinds the push above, net zero for this item
      }
    });
    expect(order).toEqual(["will-fail", "will-succeed"]);

    // Exactly one consolidated entry for the whole batch — the real stack was never popped
    // mid-batch, so the two pre-batch entries are still there underneath it.
    expect(state().undoSize).toBe(undoBeforeBatch + 1);

    // One undo comes back to right before the batch ran (still 3 devices heavier than the
    // fixture — pre-batch entry B's mutation is untouched).
    const beforeBatchNodeCount = state().nodes.length;
    state().undo();
    expect(state().nodes.length).toBe(beforeBatchNodeCount);
    expect(state().undoSize).toBe(2);

    // The two pre-batch entries are still intact and in order, not corrupted or collapsed —
    // a bare pop on the real stack during the batch would have destroyed entry B here.
    state().undo(); // back to entry A's state (post-A, pre-B)
    expect(state().undoSize).toBe(1);
    state().undo(); // back to the fixture itself
    expect(state().undoSize).toBe(0);
    expect(state().nodes).toHaveLength(file.nodes.length);
  });

  it("keeps the suppression counter balanced across an unwind, so a fully-cancelled batch pushes nothing", () => {
    state().pushSnapshot(); // one pre-batch entry to prove it survives untouched
    const undoBeforeBatch = state().undoSize;

    // Every item in the batch pushes and then unwinds — net zero real change.
    __undoBatchInternalsForTest.runAsSingleUndoStep(["a", "b", "c"], () => {
      state().pushSnapshot();
      __undoBatchInternalsForTest.undoFailedPush();
    });

    // No entry for the batch at all: the suppression counter nets to zero.
    expect(state().undoSize).toBe(undoBeforeBatch);
  });

  it("dev-mode: throws rather than let a pop outnumber pushes in the live suppression counter", () => {
    __undoBatchInternalsForTest.runAsSingleUndoStep(["only"], () => {
      state().pushSnapshot(); // counter at 1
      __undoBatchInternalsForTest.undoFailedPush(); // counter back to 0 — balanced
      expect(() => __undoBatchInternalsForTest.undoFailedPush()).toThrow(
        /more times than pushed/,
      );
    });
  });

  it("dev-mode: throws rather than pop an empty real stack outside any batch", () => {
    expect(state().undoSize).toBe(0);
    expect(() => __undoBatchInternalsForTest.undoFailedPush()).toThrow(/popped an empty undo stack/);
  });
});
