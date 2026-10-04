import { describe, it, expect } from "vitest";
import { buildHandleSnapshot } from "../routing/handleSnapshot";
import type { SchematicNode } from "../types";
import type { ReactFlowInstance, InternalNode, Node } from "@xyflow/react";

/** Minimal rfInstance stand-in: one node with the given type, position, and handle bounds. */
function rfWith(
  id: string,
  type: string,
  positionAbsolute: { x: number; y: number },
  source: { id: string; x: number; y: number; width: number; height: number }[],
): ReactFlowInstance {
  const internal = {
    id,
    type,
    measured: { width: 180, height: 160 },
    internals: { positionAbsolute, handleBounds: { source, target: [] } },
  } as unknown as InternalNode<Node>;
  return { getInternalNode: (nid: string) => (nid === id ? internal : undefined) } as unknown as ReactFlowInstance;
}

const node = (id: string, type: string): SchematicNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: {} } as unknown as SchematicNode);

describe("buildHandleSnapshot port-grid snapping", () => {
  it("snaps a device handle center with sub-grid DOM drift onto the grid", () => {
    // Device at (4000, 2000); handle measured 1px high of the model row: center (4000, 2095).
    const rf = rfWith("dev", "device", { x: 4000, y: 2000 }, [
      { id: "p1-in", x: -5, y: 90, width: 10, height: 10 },
    ]);
    const snap = buildHandleSnapshot([node("dev", "device")], rf);
    const h = snap.dev.source[0];
    expect(snap.dev.positionAbsolute.y + h.y + h.height / 2).toBe(2096);
    expect(snap.dev.positionAbsolute.x + h.x + h.width / 2).toBe(4000);
  });

  it("leaves a handle alone when it is beyond noise range of a grid line", () => {
    // Center y = 2088 — exactly between rows; must NOT be pulled to either.
    const rf = rfWith("dev", "device", { x: 4000, y: 2000 }, [
      { id: "p1-in", x: -5, y: 83, width: 10, height: 10 },
    ]);
    const h = buildHandleSnapshot([node("dev", "device")], rf).dev.source[0];
    expect(2000 + h.y + h.height / 2).toBe(2088);
  });

  it("does not snap stub-label handles", () => {
    // Stub deliberately off-grid (colinear with a healed row); handle center y = 2119.
    const rf = rfWith("s1", "stub-label", { x: 3721, y: 2112 }, [
      { id: "r", x: 153, y: 2, width: 10, height: 10 },
    ]);
    const h = buildHandleSnapshot([node("s1", "stub-label")], rf).s1.source[0];
    expect(2112 + h.y + h.height / 2).toBe(2119);
    expect(3721 + h.x + h.width / 2).toBe(3879);
  });

  it("keeps already-grid-aligned handles byte-identical (harness mock path)", () => {
    // Center (160, 368) — both exact 16-multiples.
    const rf = rfWith("dev", "device", { x: 160, y: 320 }, [
      { id: "p1", x: -5, y: 43, width: 10, height: 10 },
    ]);
    const h = buildHandleSnapshot([node("dev", "device")], rf).dev.source[0];
    expect(h.x).toBe(-5);
    expect(h.y).toBe(43);
  });
});
