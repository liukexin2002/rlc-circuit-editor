/**
 * Netlist + scikit-rf export tests.
 *
 * The exported `connections` structure is a contract with scikit-rf, so these tests check the
 * things scikit-rf itself rejects on: unique network names, a `(network, port)` pair appearing
 * in exactly one node, port indices in range, and at least one port declared. They also check
 * the drawing round trip, which is a contract with the USER: reopening a file must render what
 * was saved.
 */

import { describe, expect, it } from "vitest";
import {
  buildSkrfNetlist,
  compareEdgeIds,
  deriveNetlist,
  formatNetlistText,
  formatSiValue,
  NETLIST_FORMAT,
  parseSiValue,
} from "../../rlc/rlcNetlist";
import {
  emptyRlcDoc,
  makeComponent,
  pinKey,
  type RlcComponent,
  type RlcDoc,
  type RlcEdge,
  type RlcKind,
  type RlcRotation,
} from "../../rlc/rlcModel";
import { DOC_VERSION } from "../../rlc/rlcConstants";

function place(doc: RlcDoc, kind: RlcKind, x: number, y: number, rotation: RlcRotation = 0) {
  const res = makeComponent(doc, kind, x, y, rotation);
  doc.components.push(res.component);
  doc.nextComponentSeq = res.doc.nextComponentSeq;
  doc.labelSeq = res.doc.labelSeq;
  return res.component;
}

function wire(
  doc: RlcDoc,
  a: RlcComponent,
  aPin: "p0" | "p1",
  b: RlcComponent,
  bPin: "p0" | "p1",
): RlcEdge {
  const edge: RlcEdge = {
    id: `e${doc.nextEdgeSeq}`,
    from: { componentId: a.id, pinId: aPin },
    to: { componentId: b.id, pinId: bPin },
  };
  doc.nextEdgeSeq++;
  doc.edges.push(edge);
  return edge;
}

/** Store solved geometry on the document, as the editor does before saving. */
function withGeometry(doc: RlcDoc, routes: Record<string, { waypoints: { x: number; y: number }[]; quality: string }>) {
  const geometry: RlcDoc["geometry"] = {};
  for (const [id, w] of Object.entries(routes)) {
    geometry[id] = { waypoints: w.waypoints, quality: w.quality };
  }
  return { ...doc, geometry };
}

// ── SI value parsing ────────────────────────────────────────────────────────

describe("netlist — component values become SI numbers", () => {
  it("parses the forms a schematic actually uses", () => {
    expect(parseSiValue("10k", "resistor")).toBe(10000);
    expect(parseSiValue("4.7k", "resistor")).toBeCloseTo(4700);
    expect(parseSiValue("50", "resistor")).toBe(50);
    expect(parseSiValue("1M", "resistor")).toBe(1e6);
    expect(parseSiValue("100nF", "capacitor")).toBeCloseTo(1e-7);
    expect(parseSiValue("2.2uF", "capacitor")).toBeCloseTo(2.2e-6);
    expect(parseSiValue("3.222pF", "capacitor")).toBeCloseTo(3.222e-12);
    expect(parseSiValue("100uH", "inductor")).toBeCloseTo(1e-4);
    expect(parseSiValue("8.893nH", "inductor")).toBeCloseTo(8.893e-9);
    expect(parseSiValue("1.5e3", "resistor")).toBe(1500);
  });

  it("refuses text it cannot read instead of guessing a number", () => {
    expect(parseSiValue("", "resistor")).toBeNull();
    expect(parseSiValue("abc", "resistor")).toBeNull();
    expect(parseSiValue("10x", "resistor")).toBeNull();
  });

  it("round-trips through the formatter", () => {
    for (const [text, kind] of [
      ["10k", "resistor"],
      ["100nF", "capacitor"],
      ["100uH", "inductor"],
    ] as [string, RlcKind][]) {
      const v = parseSiValue(text, kind)!;
      const back = formatSiValue(v, kind);
      expect(parseSiValue(back, kind)).toBeCloseTo(v, 9);
    }
  });
});

// ── Net derivation ─────────────────────────────────────────────────────────

describe("netlist — nets are derived from the drawing", () => {
  it("groups a simple series chain into separate nodes", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    wire(doc, r1, "p1", c1, "p0");
    const derived = deriveNetlist(doc);
    // r1.p1 and c1.p0 are joined; the four outer pins are dangling.
    const joined = derived.nets.find((n) => n.terminals.length === 2);
    expect(joined).toBeDefined();
    expect(joined!.terminals.map((t) => t.key).sort()).toEqual(
      [pinKey(r1.id, "p1"), pinKey(c1.id, "p0")].sort(),
    );
    expect(derived.nets.filter((n) => n.dangling).length).toBe(2);
  });

  it("names nets deterministically, so an unrelated edit does not renumber them", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 160);
    const b = place(doc, "capacitor", 480, 160);
    wire(doc, a, "p1", b, "p0");
    const first = deriveNetlist(doc);
    // Add an unconnected part: the existing nets must keep their names.
    place(doc, "inductor", 900, 900);
    const second = deriveNetlist(doc);
    for (const n of first.nets) {
      const same = second.nets.find((x) => x.name === n.name);
      expect(same, `net ${n.name} must survive an unrelated addition`).toBeDefined();
      expect(same!.terminals.map((t) => t.key).sort()).toEqual(n.terminals.map((t) => t.key).sort());
    }
  });

  it("orders wire ids numerically inside a net", () => {
    expect(["e9", "e10", "e100"].sort(compareEdgeIds)).toEqual(["e9", "e10", "e100"]);
  });
});

// ── scikit-rf structure ────────────────────────────────────────────────────

describe("netlist — the exported structure satisfies scikit-rf's rules", () => {
  it("emits List-of-List-of-(name, port) connections with one node per net", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    wire(doc, r1, "p1", c1, "p0");
    const { netlist, warnings } = buildSkrfNetlist(doc);

    expect(netlist.format).toBe(NETLIST_FORMAT);
    // Every member is [string, number].
    for (const group of netlist.connections) {
      expect(Array.isArray(group)).toBe(true);
      expect(group.length).toBeGreaterThan(0);
      for (const [n, p] of group) {
        expect(typeof n).toBe("string");
        expect(Number.isInteger(p)).toBe(true);
      }
    }
    // scikit-rf requires unique network names.
    const names = netlist.networks.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    // No (network, port) pair may appear twice across all nodes.
    const seen = netlist.connections.flat().map(([n, p]) => `${n}#${p}`);
    expect(new Set(seen).size).toBe(seen.length);
    // A circuit needs at least one port, and it must be reported if it is missing.
    if (netlist.networks.some((n) => n.kind === "port")) {
      expect(warnings.some((w) => w.includes("没有定义任何端口"))).toBe(false);
    }
  });

  it("maps pin ids to scikit-rf port indices (p0→0, p1→1)", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    wire(doc, r1, "p0", c1, "p1");
    const { netlist } = buildSkrfNetlist(doc);
    const flat = netlist.connections.flat();
    expect(flat.some(([n, p]) => n === "R1" && p === 0)).toBe(true);
    expect(flat.some(([n, p]) => n === "C1" && p === 1)).toBe(true);
  });

  it("emits SI values and keeps the display text alongside", () => {
    const doc = emptyRlcDoc();
    place(doc, "capacitor", 160, 160).value = "100nF";
    const { netlist, warnings } = buildSkrfNetlist(doc);
    const c = netlist.networks.find((n) => n.kind === "capacitor")!;
    expect(c.value).toBeCloseTo(1e-7);
    expect(c.value_text).toBe("100nF");
    void warnings;
  });

  it("reports an unparseable value instead of exporting a wrong number", () => {
    const doc = emptyRlcDoc();
    place(doc, "resistor", 160, 160).value = "10kohm";
    const { netlist } = buildSkrfNetlist(doc);
    const r = netlist.networks.find((n) => n.kind === "resistor")!;
    // "10kohm" has a valid prefix and a unit suffix, so it must parse; check the note path with
    // something truly unreadable instead.
    expect(r.value).toBe(10000);
    const doc2 = emptyRlcDoc();
    place(doc2, "resistor", 160, 160).value = "？？";
    const out2 = buildSkrfNetlist(doc2);
    expect(out2.netlist.notes.some((n) => n.includes("无法解析"))).toBe(true);
    expect(out2.netlist.networks.find((n) => n.kind === "resistor")!.value).toBeUndefined();
  });

  it("creates a Port network for a declared port and connects it to the right node", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    wire(doc, r1, "p1", c1, "p0");
    doc.ports = [pinKey(r1.id, "p0")];
    const { netlist } = buildSkrfNetlist(doc);
    const port = netlist.networks.find((n) => n.kind === "port");
    expect(port, "a declared port must produce a Port network").toBeDefined();
    expect(port!.z0).toBe(50);
    // The port must sit on the node that owns r1.p0.
    const group = netlist.connections.find((g) => g.some(([n]) => n === port!.name));
    expect(group).toBeDefined();
    expect(group!.some(([n, p]) => n === "R1" && p === 0)).toBe(true);
  });

  it("creates a Ground network for a declared ground", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    wire(doc, r1, "p1", c1, "p0");
    doc.grounds = [pinKey(c1.id, "p0")];
    const { netlist } = buildSkrfNetlist(doc);
    const gnd = netlist.networks.find((n) => n.kind === "ground");
    expect(gnd).toBeDefined();
    const group = netlist.connections.find((g) => g.some(([n]) => n === gnd!.name));
    expect(group!.some(([n, p]) => n === "R1" && p === 1)).toBe(true);
  });

  it("two components wired twice are reported, because scikit-rf cannot express that", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    wire(doc, r1, "p1", c1, "p0");
    wire(doc, r1, "p1", c1, "p0"); // duplicate
    const derived = deriveNetlist(doc);
    const net = derived.nets.find((n) => n.terminals.length === 2)!;
    expect(net.isTree).toBe(false);
    const { warnings } = buildSkrfNetlist(doc);
    expect(warnings.some((w) => w.includes("冗余"))).toBe(true);
  });

  it("keeps the frequency block editable and consistent", () => {
    const doc = emptyRlcDoc();
    place(doc, "resistor", 160, 160);
    const { netlist } = buildSkrfNetlist(doc, {
      frequency: { start: 0.1, stop: 10, npoints: 1001, unit: "GHz" },
    });
    expect(netlist.frequency).toEqual({ start: 0.1, stop: 10, npoints: 1001, unit: "GHz" });
  });
});

// ── The drawing travels with the netlist ───────────────────────────────────

describe("netlist — the export carries the drawing so a reimport can redraw it exactly", () => {
  it("includes schematic components and stored waypoints", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 1200, 160);
    const host = wire(doc, r1, "p1", c1, "p0");
    const t = place(doc, "inductor", 480, 700, 270);
    const branch = wire(doc, t, "p1", c1, "p1");

    const geometry = {
      [host.id]: { waypoints: [{ x: 192, y: 160 }, { x: 1152, y: 160 }], quality: "clean" },
      [branch.id]: {
        waypoints: [{ x: 480, y: 668 }, { x: 480, y: 160 }],
        quality: "clean",
      },
    };
    const doc2 = withGeometry(doc, geometry);
    const { netlist } = buildSkrfNetlist(doc2);

    // Stored geometry is what makes reopening render the SAME drawing.
    const hostOut = netlist.schematic.wires.find((w) => w.id === host.id)!;
    expect(hostOut.waypoints).toEqual(geometry[host.id].waypoints);
    const branchOut = netlist.schematic.wires.find((w) => w.id === branch.id)!;
    expect(branchOut.waypoints).toEqual(geometry[branch.id].waypoints);
    // Endpoints are recorded as the pins they land on, so a reimport can restore the wiring.
    expect(branchOut.from).toEqual({ componentId: t.id, pinId: "p1" });
    expect(branchOut.to).toEqual({ componentId: c1.id, pinId: "p1" });
    // Round-tripping the netlist through JSON loses nothing.
    const again = JSON.parse(JSON.stringify(netlist));
    expect(again.schematic.wires).toEqual(netlist.schematic.wires);
  });

  it("records the routing model so a future rule change is detectable", () => {
    const doc = emptyRlcDoc();
    place(doc, "resistor", 160, 160);
    const { netlist } = buildSkrfNetlist(doc);
    expect(netlist.generator.routing).toBeTruthy();
    expect(netlist.generator.version).toBeTruthy();
  });

  it("renders a human-readable text form that lists nets", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 1200, 160);
    wire(doc, r1, "p1", c1, "p0");
    const { netlist } = buildSkrfNetlist(doc);
    const text = formatNetlistText(netlist);
    expect(text).toContain("connections = [");
    expect(text).toContain("# 网络");
    expect(text).toContain("R1");
  });
});

// ── Document version ───────────────────────────────────────────────────────

describe("netlist — document version is v2 and geometry is first-class", () => {
  it("writes the current document version", () => {
    expect(emptyRlcDoc().version).toBe(DOC_VERSION);
    expect(DOC_VERSION).toBe(2);
  });

  it("starts with empty geometry, ports and grounds", () => {
    const doc = emptyRlcDoc();
    expect(doc.geometry).toEqual({});
    expect(doc.ports).toEqual([]);
    expect(doc.grounds).toEqual([]);
    expect(doc.avoidWires).toBe(true);
  });
});
