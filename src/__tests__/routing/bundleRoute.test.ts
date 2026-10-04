import { describe, it, expect } from "vitest";
import { computeBundleTrunk } from "../../routing/bundleRoute";

describe("computeBundleTrunk", () => {
  it("anchors the trunk at the median endpoint Y and spans source→target clusters", () => {
    const t = computeBundleTrunk([
      { edgeId: "e1", srcX: 0, srcY: 0, tgtX: 500, tgtY: 100 },
      { edgeId: "e2", srcX: 20, srcY: 200, tgtX: 520, tgtY: 300 },
    ], 40);
    expect(t.entry.x).toBe(60);  // max srcX(20) + 40
    expect(t.exit.x).toBe(460);  // min tgtX(500) - 40
    expect(t.entry.y).toBe(t.exit.y); // horizontal trunk
    expect(t.entry.y).toBe(150); // median of {0,100,200,300}
  });
  it("uses the middle value for an odd endpoint count", () => {
    const t = computeBundleTrunk([
      { edgeId: "e1", srcX: 0, srcY: 0, tgtX: 100, tgtY: 0 },
      { edgeId: "e2", srcX: 0, srcY: 50, tgtX: 100, tgtY: 50 },
      { edgeId: "e3", srcX: 0, srcY: 90, tgtX: 100, tgtY: 90 },
    ], 40);
    // Ys sorted: 0,0,50,50,90,90 (6 values, even) → median of 50,50 = 50
    expect(t.entry.y).toBe(50);
  });
});
