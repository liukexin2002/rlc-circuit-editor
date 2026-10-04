import { describe, expect, it } from "vitest";
import { anchorRouteEndpoints, tuckSubgridSteps, type Point } from "../../pathfinding";

/** Every segment must be axis-aligned and non-degenerate. */
function expectOrthogonal(wps: Point[]) {
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    expect(dx === 0 || dy === 0, `seg ${i} diagonal: ${JSON.stringify([a, b])}`).toBe(true);
    expect(dx + dy, `seg ${i} zero-length`).toBeGreaterThan(0);
  }
}

describe("anchorRouteEndpoints", () => {
  it("is a no-op when endpoints are already exact", () => {
    const wps = [{ x: 100, y: 200 }, { x: 160, y: 200 }, { x: 160, y: 300 }, { x: 240, y: 300 }];
    const out = anchorRouteEndpoints(wps, { x: 100, y: 200 }, { x: 240, y: 300 });
    expect(out).toEqual(wps);
  });

  it("absorbs a Y delta into the adjacent vertical (horizontal endpoint segment)", () => {
    // Snapped route at y=200/300; true pins 7px off-grid.
    const wps = [{ x: 100, y: 200 }, { x: 160, y: 200 }, { x: 160, y: 300 }, { x: 240, y: 300 }];
    const out = anchorRouteEndpoints(wps, { x: 103, y: 207 }, { x: 240, y: 293 });
    expect(out[0]).toEqual({ x: 103, y: 207 });
    expect(out[out.length - 1]).toEqual({ x: 240, y: 293 });
    expectOrthogonal(out);
    // Same turn count — the vertical absorbed the shift, no new step.
    expect(out.length).toBe(4);
    expect(out[1]).toEqual({ x: 160, y: 207 });
    expect(out[2]).toEqual({ x: 160, y: 293 });
  });

  it("anchors both ends of a 3-point L", () => {
    const wps = [{ x: 100, y: 200 }, { x: 180, y: 200 }, { x: 180, y: 320 }];
    const out = anchorRouteEndpoints(wps, { x: 100, y: 206 }, { x: 174, y: 320 });
    expect(out[0]).toEqual({ x: 100, y: 206 });
    expect(out[out.length - 1]).toEqual({ x: 174, y: 320 });
    expectOrthogonal(out);
    expect(out.length).toBe(3);
    expect(out[1]).toEqual({ x: 174, y: 206 });
  });

  it("collapses a straight horizontal leg whose exact endpoints share a row", () => {
    const wps = [{ x: 100, y: 200 }, { x: 300, y: 200 }];
    const out = anchorRouteEndpoints(wps, { x: 98, y: 207 }, { x: 305, y: 207 });
    expect(out).toEqual([{ x: 98, y: 207 }, { x: 305, y: 207 }]);
  });

  it("inserts one port-hugging step when a straight leg's exact endpoints disagree in Y", () => {
    const wps = [{ x: 100, y: 200 }, { x: 300, y: 200 }];
    const out = anchorRouteEndpoints(wps, { x: 100, y: 207 }, { x: 300, y: 213 });
    expect(out[0]).toEqual({ x: 100, y: 207 });
    expect(out[out.length - 1]).toEqual({ x: 300, y: 213 });
    expectOrthogonal(out);
    expect(out.length).toBe(4);
    // Step parked one cell (16px) from the target pin.
    expect(out[1].x).toBe(284);
    expect(out[2].x).toBe(284);
    // First and last segments stay horizontal (arrival rule).
    expect(out[0].y).toBe(out[1].y);
    expect(out[2].y).toBe(out[3].y);
  });

  it("absorbs an X delta into the adjacent horizontal (vertical endpoint segment)", () => {
    const wps = [{ x: 100, y: 200 }, { x: 100, y: 300 }, { x: 240, y: 300 }];
    const out = anchorRouteEndpoints(wps, { x: 107, y: 200 }, { x: 240, y: 300 });
    expect(out[0]).toEqual({ x: 107, y: 200 });
    expectOrthogonal(out);
    expect(out[1]).toEqual({ x: 107, y: 300 });
  });
});

describe("tuckSubgridSteps", () => {
  it("slides a mid-span sub-grid step against a pin (icdc shape; start pin wins a tie)", () => {
    // h(40) → v(7px step at corridor) → h(60 into pin): the real icdc defect. Both flanks touch
    // a route end here; the start side is preferred (arbitrary but deterministic — either end
    // reads as a port entry).
    const wps = [
      { x: 366480, y: 114700 },
      { x: 366520, y: 114700 },
      { x: 366520, y: 114707 },
      { x: 366580, y: 114707 },
    ];
    const out = tuckSubgridSteps(wps);
    expect(out).toEqual([
      { x: 366480, y: 114700 },
      { x: 366496, y: 114700 },
      { x: 366496, y: 114707 },
      { x: 366580, y: 114707 },
    ]);
    expectOrthogonal(out);
  });

  it("slides a step toward the start pin when the start flank touches it (bundle shape)", () => {
    const wps = [
      { x: 180, y: 310 },
      { x: 220, y: 310 },
      { x: 220, y: 320 },
      { x: 600, y: 320 },
      { x: 600, y: 60 },
    ];
    const out = tuckSubgridSteps(wps);
    expect(out[1]).toEqual({ x: 196, y: 310 });
    expect(out[2]).toEqual({ x: 196, y: 320 });
    expect(out[0]).toEqual(wps[0]);
    expect(out[3]).toEqual(wps[3]);
    expectOrthogonal(out);
  });

  it("leaves full-cell steps alone", () => {
    const wps = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 20 }, // exactly one cell — the classic aligned-endpoint step
      { x: 100, y: 20 },
    ];
    expect(tuckSubgridSteps(wps)).toBe(wps);
  });

  it("leaves switchbacks (direction reversal) alone", () => {
    const wps = [
      { x: 100, y: 0 },
      { x: 140, y: 0 },
      { x: 140, y: 7 },
      { x: 40, y: 7 }, // reverses x-direction — not a stair
      { x: 40, y: 100 },
    ];
    expect(tuckSubgridSteps(wps)).toBe(wps);
  });

  it("leaves deep-interior steps alone (no flank touches a route end)", () => {
    const wps = [
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 40, y: 50 },
      { x: 40, y: 57 },
      { x: 100, y: 57 },
      { x: 100, y: 120 },
    ];
    expect(tuckSubgridSteps(wps)).toBe(wps);
  });
});
