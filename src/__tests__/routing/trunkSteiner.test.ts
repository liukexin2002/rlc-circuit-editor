import { describe, it, expect } from "vitest";
import { buildTrunk } from "../../routing/trunkSteiner";

describe("buildTrunk (single-trunk Steiner)", () => {
  it("anchors the spine at the median of target Ys and orders branches by Y", () => {
    const t = buildTrunk({
      sourceX: 0,
      sourceY: 100,
      trunkX: 20,
      targets: [
        { id: "t0", x: 40, y: 0 },
        { id: "t1", x: 40, y: 40 },
        { id: "t2", x: 40, y: 200 },
      ],
    });
    expect(t.trunkY).toBe(40); // median of {0,40,200}
    expect(t.trunkX).toBe(20);
    expect(t.branches.map((b) => b.id)).toEqual(["t0", "t1", "t2"]); // ordered by Y
  });

  it("averages the two middle Ys for an even count", () => {
    const t = buildTrunk({
      sourceX: 0,
      sourceY: 0,
      trunkX: 10,
      targets: [
        { id: "a", x: 30, y: 0 },
        { id: "b", x: 30, y: 100 },
      ],
    });
    expect(t.trunkY).toBe(50);
  });

  it("is deterministic for equal Ys (id tie-break)", () => {
    const mk = (ids: string[]) =>
      buildTrunk({ sourceX: 0, sourceY: 0, trunkX: 0, targets: ids.map((id) => ({ id, x: 10, y: 5 })) }).branches.map((b) => b.id);
    expect(mk(["b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
});
