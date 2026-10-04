import { describe, it, expect } from "vitest";
import { buildTrunkEdge } from "../../routing/trunkModel";
import { orderTrunks } from "../../routing/constraintGraph";

const mk = (id: string, srcGY: number, tgtGY: number, tgtGX = 40) =>
  buildTrunkEdge({ id, srcGX: 0, srcGY, tgtGX, tgtGY, targetEntersLeft: true, signalType: "sdi" });

describe("orderTrunks (VCG)", () => {
  it("orders a one-source fan with no cycles (every trunk placed)", () => {
    // One source (y100) → three targets. Same source → no contradictory pair → no cycles,
    // and all trunks get a place. (The crossing-OPTIMAL order is validated by the harness,
    // not asserted here — the optimal order for a mixed up/down fan is non-obvious.)
    const { order, cycles } = orderTrunks([mk("a", 100, 50), mk("b", 100, 0), mk("c", 100, 150)]);
    expect(cycles.length).toBe(0);
    expect(order.length).toBe(3);
    expect(new Set(order.map((t) => t.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("flags a cycle when two trunks' source and target orders disagree", () => {
    // a: src above b at source (0<100) but below b at target (100>0) → contradiction.
    const { cycles } = orderTrunks([mk("a", 0, 100), mk("b", 100, 0)]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("is deterministic for equal keys (id tie-break)", () => {
    const r1 = orderTrunks([mk("y", 0, 10), mk("x", 0, 10)]);
    const r2 = orderTrunks([mk("x", 0, 10), mk("y", 0, 10)]);
    expect(r1.order.map((t) => t.id)).toEqual(r2.order.map((t) => t.id));
  });
});
