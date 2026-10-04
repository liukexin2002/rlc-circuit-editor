/**
 * #323 — "Stub labels anchor to distant elements instead of their source connector".
 *
 * computeSnap offered every port of every device within MAX_SNAP_DISTANCE (800px) as a
 * snap target for a dragged stub tag, and pickBest ranks all port candidates equally by
 * |delta|. Any unrelated device whose port row happened to be a few px closer therefore
 * won, latching the tag onto a connector it has nothing to do with. Only the tag's OWN
 * port — the device end of its leg — may snap now.
 */
import { describe, it, expect } from "vitest";
import { computeSnap, getPortAbsolutePositions } from "../snapUtils";
import { STUB_GAP, STUB_H_EST } from "../stubPlacement";
import type { ConnectionEdge, Port, SchematicNode } from "../types";

const port = (id: string, label: string, direction: Port["direction"]): Port =>
  ({ id, label, signalType: "sdi", direction } as Port);

const device = (id: string, label: string, x: number, y: number, ports: Port[]): SchematicNode =>
  ({
    id, type: "device", position: { x, y },
    data: { label, deviceType: "misc", ports },
    measured: { width: 144, height: 48 + ports.length * 20 },
  } as unknown as SchematicNode);

const tag = (id: string, x: number, y: number): SchematicNode =>
  ({
    id, type: "stub-label", position: { x, y },
    data: { signalType: "sdi", linkedConnectionId: "link-1", side: "target", placed: true },
    measured: { width: 137, height: STUB_H_EST },
  } as unknown as SchematicNode);

/** The tag's own leg: tag ──▶ device port (a target-side leg). */
const leg = (tagId: string, deviceId: string, handleId: string): ConnectionEdge =>
  ({
    id: "e1-tgt", source: tagId, sourceHandle: "r", target: deviceId, targetHandle: handleId,
    data: { signalType: "sdi", linkedConnectionId: "link-1" },
  } as unknown as ConnectionEdge);

function portRow(dev: SchematicNode, handleId: string, nodes: SchematicNode[]) {
  const map = new Map(nodes.map((n) => [n.id, n] as const));
  const p = getPortAbsolutePositions(dev, map).find((q) => q.handleId === handleId);
  if (!p) throw new Error(`no port ${handleId}`);
  return p;
}

describe("stub tags snap to their own connector, not a neighbour's (#323)", () => {
  // Own device: SWITCHER at x=900. A decoy rack sits 300px to the left with a port row
  // 6px off the tag's current row — inside SNAP_THRESHOLD (20px), and nearer than the
  // tag's own port row, so it used to win outright.
  const own = device("dev-switcher", "SWITCHER", 900, 100, [
    port("p1", "SDI IN 1", "input"),
    port("p2", "SDI IN 2", "input"),
  ]);
  const decoy = device("dev-decoy", "PATCH RACK", 300, 60, [
    port("q1", "TIE 1", "input"),
    port("q2", "TIE 2", "input"),
    port("q3", "TIE 3", "input"),
  ]);

  it("aligns the tag's centre with its own port row", () => {
    const base = [own, decoy];
    const ownPort = portRow(own, "p1", base);
    const decoyPort = portRow(decoy, "q3", base);
    // Sanity: the decoy row really is the closer temptation for this drag.
    const dropY = ownPort.absY - 14;
    expect(Math.abs(decoyPort.absY - dropY)).toBeLessThan(Math.abs(ownPort.absY - dropY));
    expect(Math.abs(decoyPort.absY - dropY)).toBeLessThanOrEqual(20);

    const dragged = tag("stub-e1-tgt", ownPort.absX - STUB_GAP - 137, dropY - STUB_H_EST / 2);
    const nodes = [...base, dragged];
    const snap = computeSnap(dragged, nodes, undefined, [leg(dragged.id, "dev-switcher", "p1")]);

    // Tag centre lands on its own port's row, not the decoy's.
    expect(snap.y + STUB_H_EST / 2).toBe(ownPort.absY);
    expect(snap.y + STUB_H_EST / 2).not.toBe(decoyPort.absY);
  });

  it("parks the tag STUB_GAP from its own port on the X axis", () => {
    const base = [own, decoy];
    const ownPort = portRow(own, "p1", base);
    // Dropped 9px short of the canonical gap — within threshold, so the snap closes it.
    const dragged = tag("stub-e1-tgt", ownPort.absX - STUB_GAP - 137 + 9, ownPort.absY - STUB_H_EST / 2);
    const nodes = [...base, dragged];
    const snap = computeSnap(dragged, nodes, undefined, [leg(dragged.id, "dev-switcher", "p1")]);

    expect(snap.x + 137).toBe(ownPort.absX - STUB_GAP);
  });

  it("heals a bare handle ref against a port that became bidirectional", () => {
    const bidir = device("dev-bidir", "MATRIX", 900, 100, [
      port("p1", "SDI 1", "bidirectional"),
    ]);
    const base = [bidir, decoy];
    const p = getPortAbsolutePositions(bidir, new Map(base.map((n) => [n.id, n] as const)))
      .find((q) => q.portId === "p1")!;
    const dragged = tag("stub-e1-tgt", p.absX - STUB_GAP - 137, p.absY - STUB_H_EST / 2 - 6);
    const nodes = [...base, dragged];
    // Leg stored against the bare port id, from before the port went bidirectional.
    const snap = computeSnap(dragged, nodes, undefined, [leg(dragged.id, "dev-bidir", "p1")]);

    expect(snap.y + STUB_H_EST / 2).toBe(p.absY);
  });

  it("still uses nearby ports for a tag whose leg is gone", () => {
    // An orphaned tag has no own port to anchor to — the old nearest-device scan is the
    // only thing left, and it must still work rather than dropping to bare grid snap.
    const base = [own, decoy];
    const decoyPort = portRow(decoy, "q3", base);
    const dragged = tag("stub-orphan", decoyPort.absX - STUB_GAP - 137, decoyPort.absY - STUB_H_EST / 2 - 5);
    const snap = computeSnap(dragged, [...base, dragged], undefined, []);
    expect(snap.y + STUB_H_EST / 2).toBe(decoyPort.absY);
  });
});

/**
 * #342 — the other half of #323: the tag-to-tag alignment scan.
 *
 * A tag dragged more than SNAP_THRESHOLD clear of its own port row has no port candidate
 * left, so any tag inside the 800px scan radius could claim the drop. Column alignment
 * needs that radius; row alignment does not, and because every port row on the page sits
 * on the same 16px pitch there is nearly always SOME far-away tag whose row falls inside
 * the threshold. Reach is now asymmetric: full radius DOWN a column, 320px ACROSS a row.
 */
describe("tag-to-tag alignment reach is axis-asymmetric (#342)", () => {
  const own = device("dev-switcher", "SWITCHER", 900, 100, [
    port("p1", "SDI IN 1", "input"),
    port("p2", "SDI IN 2", "input"),
  ]);
  const ownLeg = leg("stub-e1-tgt", "dev-switcher", "p1");

  /** Drop point well clear of the tag's own port on BOTH axes, so section 1 offers
   *  nothing and only the tag-to-tag scan can decide where this lands. */
  function droppedFarFromItsPort() {
    const ownPort = portRow(own, "p1", [own]);
    const left = ownPort.absX - STUB_GAP - 137 - 400;
    const top = ownPort.absY + 200;
    return { dragged: tag("stub-e1-tgt", left, top), left, top };
  }

  it("still aligns a column peer 600px below", () => {
    const { dragged, left, top } = droppedFarFromItsPort();
    // Directly below and 9px out of true — a deliberate column the user is tidying.
    const peer = tag("stub-column-peer", left + 9, top + 600);
    const snap = computeSnap(dragged, [own, dragged, peer], undefined, [ownLeg]);
    expect(snap.x).toBe(left + 9);
  });

  it("no longer takes the row of an unrelated tag 700px to the side", () => {
    const { dragged, left, top } = droppedFarFromItsPort();
    // 700px away with a row 6px off — the accidental latch. 563px of clear space
    // between the boxes, well past STUB_ROW_REACH.
    const stranger = tag("stub-stranger", left + 700, top + 6);
    const snap = computeSnap(dragged, [own, dragged, stranger], undefined, [ownLeg]);

    expect(snap.y).not.toBe(top + 6);
    // No row candidate left, so the centre falls back to the grid — the same 16px
    // pitch every port row sits on.
    expect((snap.y + STUB_H_EST / 2) % 16).toBe(0);
  });

  it("keeps row alignment for a tag inside the row reach", () => {
    const { dragged, left, top } = droppedFarFromItsPort();
    // Two tags flanking one device leave ~272px of CLEAR SPACE between the boxes
    // (device width plus a STUB_GAP each side); that case must still snap. The gap
    // the reach is compared against is box-to-box, so the peer's left edge goes a
    // full tag width further out — measuring from `left` alone would test a 135px
    // gap and pass under a reach 2.4x tighter than the case it names.
    const neighbour = tag("stub-neighbour", left + 137 + 272, top + 6);
    const snap = computeSnap(dragged, [own, dragged, neighbour], undefined, [ownLeg]);
    expect(snap.y).toBe(top + 6);
  });

  it("sizes an unmeasured peer as a tag, not as a device", () => {
    // Before React Flow measures a tag (first render, an import that has not painted
    // yet) the scan has to estimate its box. Estimating a device's 144x48 puts the
    // peer's right edge 64px out and its row 17px down, so the column the user can see
    // does not snap. STUB_W_EST/STUB_H_EST are what placement and the router assume.
    const { dragged, left, top } = droppedFarFromItsPort();
    const unmeasured = {
      ...tag("stub-unmeasured", left + 57, top + 600), // right edge at left + 137 with an 80px box
      measured: undefined,
    } as SchematicNode;
    const snap = computeSnap(dragged, [own, dragged, unmeasured], undefined, [ownLeg]);
    expect(snap.x).toBe(left);
  });
});
