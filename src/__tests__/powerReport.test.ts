import { describe, it, expect } from "vitest";
import { computePowerReport } from "../powerReport";
import type { SchematicNode, ConnectionEdge } from "../types";

const distro = (id: string, capacityW: number): SchematicNode =>
  ({
    id,
    type: "device",
    position: { x: 0, y: 0 },
    data: { label: id, deviceType: "power", powerCapacityW: capacityW },
  } as unknown as SchematicNode);

const device = (id: string, powerDrawW: number): SchematicNode =>
  ({
    id,
    type: "device",
    position: { x: 0, y: 0 },
    data: { label: id, model: id, deviceType: "amp", powerDrawW },
  } as unknown as SchematicNode);

/** An in-line passthrough (e.g. an L5-20→Edison adapter): conducts power, draws 0, no capacity. */
const passthrough = (id: string): SchematicNode =>
  ({
    id,
    type: "device",
    position: { x: 0, y: 0 },
    data: { label: id, model: id, deviceType: "adapter", powerDrawW: 0 },
  } as unknown as SchematicNode);

const stubNode = (id: string, link: string, side: "source" | "target"): SchematicNode =>
  ({
    id,
    type: "stub-label",
    position: { x: 0, y: 0 },
    data: { signalType: "power", linkedConnectionId: link, side },
  } as unknown as SchematicNode);

const powerEdge = (id: string, source: string, target: string): ConnectionEdge =>
  ({ id, source, target, data: { signalType: "power" } } as unknown as ConnectionEdge);

/** A 3-phase feed: five parallel cam-lok conductors (L1/L2/L3/N/G) src → tgt. */
const threePhaseFeed = (baseId: string, source: string, target: string): ConnectionEdge[] =>
  ["power-l1", "power-l2", "power-l3", "power-neutral", "power-ground"].map(
    (sig, i) =>
      ({ id: `${baseId}-${i}`, source, target, data: { signalType: sig } } as unknown as ConnectionEdge),
  );

/** Two legs of a stubbed power connection src → tgt, joined by linkedConnectionId. */
const stubbedPowerLegs = (
  baseId: string,
  src: string,
  stubSrc: string,
  stubTgt: string,
  tgt: string,
  link: string,
): ConnectionEdge[] => [
  {
    id: `${baseId}-src`,
    source: src,
    target: stubSrc,
    data: { signalType: "power", linkedConnectionId: link },
  } as unknown as ConnectionEdge,
  {
    id: `${baseId}-tgt`,
    source: stubTgt,
    target: tgt,
    data: { signalType: "power", linkedConnectionId: link },
  } as unknown as ConnectionEdge,
];

describe("computePowerReport — distro loading", () => {
  it("counts a direct (non-stubbed) power connection as load", () => {
    const nodes = [distro("strip", 1800), device("amp", 300)];
    const edges = [powerEdge("e1", "strip", "amp")];
    const { distros } = computePowerReport(nodes, edges);
    expect(distros).toHaveLength(1);
    expect(distros[0].loadW).toBe(300);
  });

  it("counts a STUBBED power connection as load (#172)", () => {
    const nodes = [
      distro("strip", 1800),
      device("amp", 300),
      stubNode("stub-e1-src", "link1", "source"),
      stubNode("stub-e1-tgt", "link1", "target"),
    ];
    const edges = stubbedPowerLegs("e1", "strip", "stub-e1-src", "stub-e1-tgt", "amp", "link1");
    const { distros } = computePowerReport(nodes, edges);
    expect(distros[0].loadW).toBe(300);
  });

  it("does not double-count a mix of direct and stubbed loads", () => {
    const nodes = [
      distro("strip", 1800),
      device("amp1", 300),
      device("amp2", 250),
      stubNode("stub-e2-src", "link2", "source"),
      stubNode("stub-e2-tgt", "link2", "target"),
    ];
    const edges = [
      powerEdge("e1", "strip", "amp1"),
      ...stubbedPowerLegs("e2", "strip", "stub-e2-src", "stub-e2-tgt", "amp2", "link2"),
    ];
    const { distros } = computePowerReport(nodes, edges);
    expect(distros[0].loadW).toBe(550);
  });

  it("counts load through an in-line passthrough adapter (distro → adapter → device)", () => {
    // The default schematic wires a Mac Studio behind an L5-20→Edison adapter:
    // the walk must pass THROUGH the adapter, not dead-end at its 0W draw.
    const nodes = [distro("DB-100", 20800), passthrough("adapter"), device("mac", 150)];
    const edges = [
      powerEdge("e1", "DB-100", "adapter"),
      powerEdge("e2", "adapter", "mac"),
    ];
    const { distros, unconnectedPowerW } = computePowerReport(nodes, edges);
    expect(distros[0].loadW).toBe(150);
    expect(unconnectedPowerW).toBe(0);
  });

  it("counts load through daisy-chained distros (distro → distro → device)", () => {
    const nodes = [distro("company-switch", 144000), distro("DB-100", 20800), device("mac", 150)];
    const edges = [
      powerEdge("e1", "company-switch", "DB-100"),
      powerEdge("e2", "DB-100", "mac"),
    ];
    const { distros } = computePowerReport(nodes, edges);
    const cs = distros.find((d) => d.label === "company-switch")!;
    const db = distros.find((d) => d.label === "DB-100")!;
    expect(db.loadW).toBe(150);
    expect(cs.loadW).toBe(150); // upstream distro sees the same load through the chain
  });

  it("counts load across a 3-phase feed without multiplying by conductor count", () => {
    // Company switch → DB-100 over 5 cam-lok conductors → adapter → Mac Studio.
    // The 5 parallel power-l*/neutral/ground edges are ONE feed; the 150W load
    // must be counted once, not ×5 (and the per-conductor signal types must be
    // recognized as power at all).
    const nodes = [
      distro("company-switch", 144000),
      distro("DB-100", 20800),
      passthrough("adapter"),
      device("mac", 150),
    ];
    const edges = [
      ...threePhaseFeed("feed", "company-switch", "DB-100"),
      powerEdge("e1", "DB-100", "adapter"),
      powerEdge("e2", "adapter", "mac"),
    ];
    const { distros } = computePowerReport(nodes, edges);
    const cs = distros.find((d) => d.label === "company-switch")!;
    const db = distros.find((d) => d.label === "DB-100")!;
    expect(cs.loadW).toBe(150); // not 750 (=150×5)
    expect(db.loadW).toBe(150);
  });

  it("does not mark a stubbed device as unconnected power", () => {
    const nodes = [
      distro("strip", 1800),
      device("amp", 300),
      stubNode("stub-e1-src", "link1", "source"),
      stubNode("stub-e1-tgt", "link1", "target"),
    ];
    const edges = stubbedPowerLegs("e1", "strip", "stub-e1-src", "stub-e1-tgt", "amp", "link1");
    const { unconnectedPowerW } = computePowerReport(nodes, edges);
    expect(unconnectedPowerW).toBe(0);
  });

  // (#345) A power-supply's own powerCapacityW must be counted exactly like a
  // power-distribution or company-switch distro: it gets its own loading row,
  // and its capacity is never confused with the powerDrawW an upstream distro
  // sees it pull.
  it("treats a power-supply's capacity exactly like a distro's (#345)", () => {
    const psu = (id: string, capacityW: number, powerDrawW = 0): SchematicNode =>
      ({
        id,
        type: "device",
        position: { x: 0, y: 0 },
        data: { label: id, deviceType: "power-supply", powerCapacityW: capacityW, powerDrawW },
      } as unknown as SchematicNode);

    const nodes = [
      distro("strip", 1800),
      psu("psu", 100, 20), // pulls 20W from the strip, outputs up to 100W
      device("camera", 60),
    ];
    const edges = [powerEdge("e1", "strip", "psu"), powerEdge("e2", "psu", "camera")];
    const { distros, unconnectedPowerW } = computePowerReport(nodes, edges);

    expect(distros).toHaveLength(2);
    const stripRow = distros.find((d) => d.label === "strip")!;
    const psuRow = distros.find((d) => d.label === "psu")!;

    // The strip's downstream load is the PSU's own draw (20W) plus everything
    // behind it (60W) — not the PSU's 100W capacity figure.
    expect(stripRow.loadW).toBe(80);
    // The PSU's own row measures its output load (60W) against its own
    // capacity (100W) — a separate figure from what it draws upstream.
    expect(psuRow.loadW).toBe(60);
    expect(psuRow.capacityW).toBe(100);
    expect(psuRow.loadPercent).toBe(60);
    // The PSU's own input is fed by the strip, so its 20W draw is accounted for.
    expect(unconnectedPowerW).toBe(0);
  });
});

/** A capacity-bearing power supply that also draws power of its own. */
const psuWithDraw = (id: string, capacityW: number, powerDrawW: number): SchematicNode =>
  ({
    id,
    type: "device",
    position: { x: 0, y: 0 },
    data: { label: id, model: id, deviceType: "power-supply", powerCapacityW: capacityW, powerDrawW },
  } as unknown as SchematicNode);

describe("computePowerReport — unconnected power for capacity-bearing devices (#345)", () => {
  it("counts a power supply whose own input is unwired", () => {
    // Nothing feeds the PSU, so its 120W has to come from somewhere the drawing
    // does not show — exactly what the unconnected-power warning is for. It
    // still gets its own loading row.
    const nodes = [psuWithDraw("psu", 100, 120), device("camera", 60)];
    const edges = [powerEdge("e1", "psu", "camera")];
    const { distros, unconnectedPowerW } = computePowerReport(nodes, edges);

    expect(unconnectedPowerW).toBe(120);
    expect(distros).toHaveLength(1);
    expect(distros[0].label).toBe("psu");
    expect(distros[0].loadW).toBe(60);
  });

  it("does not count the same power supply once its input is wired upstream", () => {
    const nodes = [distro("strip", 1800), psuWithDraw("psu", 100, 120), device("camera", 60)];
    const edges = [powerEdge("e0", "strip", "psu"), powerEdge("e1", "psu", "camera")];
    const { distros, unconnectedPowerW } = computePowerReport(nodes, edges);

    expect(unconnectedPowerW).toBe(0);
    expect(distros).toHaveLength(2);
    // The strip carries the PSU's own draw plus everything behind it.
    expect(distros.find((d) => d.label === "strip")!.loadW).toBe(180);
  });

  it("leaves a passive distro that draws nothing of its own out of the tally", () => {
    const nodes = [distro("strip", 1800), device("amp", 300)];
    const edges = [powerEdge("e1", "strip", "amp")];
    const { unconnectedPowerW } = computePowerReport(nodes, edges);

    expect(unconnectedPowerW).toBe(0);
  });
});
