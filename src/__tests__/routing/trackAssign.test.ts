import { describe, it, expect } from "vitest";
import { colorByYSpan, laneCount, packOrdered } from "../../routing/trackAssign";

describe("colorByYSpan (Left-Edge interval coloring)", () => {
  it("gives overlapping Y-spans distinct colors and lets disjoint spans share", () => {
    // a:[0,10] and b:[100,110] are disjoint → may share color 0.
    // c:[5,105] overlaps both → must differ from whichever color it shares an X with.
    const coloring = colorByYSpan([
      { id: "a", yMin: 0, yMax: 10 },
      { id: "b", yMin: 100, yMax: 110 },
      { id: "c", yMin: 5, yMax: 105 },
    ]);
    expect(coloring.get("a")).toBe(0);
    expect(coloring.get("b")).toBe(0); // disjoint from a → reuses color 0
    expect(coloring.get("c")).not.toBe(0); // overlaps both → distinct
  });

  it("uses exactly `density` colors for a fully-overlapping fan (optimal packing)", () => {
    // Four spans all overlapping around y20 → density 4 → 4 colors.
    const coloring = colorByYSpan([0, 1, 2, 3].map((i) => ({ id: `e${i}`, yMin: 0, yMax: 20 + i })));
    expect(laneCount(coloring)).toBe(4);
  });

  it("packs a chain of disjoint spans onto a single color", () => {
    const coloring = colorByYSpan([
      { id: "a", yMin: 0, yMax: 10 },
      { id: "b", yMin: 20, yMax: 30 },
      { id: "c", yMin: 40, yMax: 50 },
    ]);
    expect(laneCount(coloring)).toBe(1);
  });

  it("respects the gap so near-touching spans don't share", () => {
    // gap=2: [0,10] and [11,20] are only 1 apart → must NOT share.
    const coloring = colorByYSpan(
      [
        { id: "a", yMin: 0, yMax: 10 },
        { id: "b", yMin: 11, yMax: 20 },
      ],
      2,
    );
    expect(laneCount(coloring)).toBe(2);
  });
});

describe("packOrdered (order-preserving packing)", () => {
  it("keeps columns monotonic in input order (never reorders to pack)", () => {
    // Order: a(top target), b(overlaps a), c(disjoint from a but AFTER b).
    // Raw Left-Edge would put c on a's column (reorder); packOrdered must NOT — c stays
    // outer (column >= b's) to preserve the nesting order.
    const cols = packOrdered([
      { id: "a", yMin: 0, yMax: 10 },
      { id: "b", yMin: 5, yMax: 15 },
      { id: "c", yMin: 100, yMax: 110 },
    ]);
    expect(cols.get("a")).toBe(0);
    expect(cols.get("b")).toBe(1);
    expect(cols.get("c")!).toBeGreaterThanOrEqual(cols.get("b")!); // monotonic, not reordered
  });

  it("merges consecutive disjoint trunks onto one column", () => {
    const cols = packOrdered([
      { id: "a", yMin: 0, yMax: 10 },
      { id: "b", yMin: 50, yMax: 60 },
      { id: "c", yMin: 100, yMax: 110 },
    ]);
    expect(laneCount(cols)).toBe(1); // all consecutive + disjoint → one column
  });

  it("advances a column when a trunk overlaps the current column", () => {
    const cols = packOrdered([
      { id: "a", yMin: 0, yMax: 100 },
      { id: "b", yMin: 50, yMax: 60 },
    ]);
    expect(cols.get("a")).toBe(0);
    expect(cols.get("b")).toBe(1);
  });
});
