/**
 * Generate a real netlist export for verification.
 *
 * Builds the classic low-pass LC filter (the topology from scikit-rf's own Circuit tutorial:
 * series L, shunt C to ground) plus a TAP, routes it, and writes the exported JSON to
 * netlist/example-lowpass.json. The Python loader is then run against that file, which is what
 * makes the scikit-rf compatibility claim an executed check rather than a reading of the docs.
 *
 * Run: npx tsx tools/export-example-netlist.ts
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  emptyRlcDoc,
  makeComponent,
  pinKey,
  pinPos,
  type RlcDoc,
  type RlcKind,
  type RlcRotation,
} from "../src/rlc/rlcModel";
import { routeDocument } from "../src/rlc/rlcRouting";
import { buildSkrfNetlist } from "../src/rlc/rlcNetlist";

function place(
  doc: RlcDoc,
  kind: RlcKind,
  x: number,
  y: number,
  rotation: RlcRotation = 0,
  value?: string,
) {
  const res = makeComponent(doc, kind, x, y, rotation);
  if (value) res.component.value = value;
  doc.components.push(res.component);
  doc.nextComponentSeq = res.doc.nextComponentSeq;
  doc.labelSeq = res.doc.labelSeq;
  return res.component;
}

const doc = emptyRlcDoc();

// Series inductor on the main line, between an input port and an output port.
const portIn = place(doc, "resistor", 160, 320, 0, "50");
portIn.label = "RIN"; // 50 Ω source representation; PORT1 is the excitation
const l2 = place(doc, "inductor", 640, 320, 0, "8.893nH");
const portOut = place(doc, "resistor", 1280, 320, 0, "50");
portOut.label = "ROUT";

// Shunt capacitors (rotated 90° so they hang vertically) tapped onto the main line.
const c1 = place(doc, "capacitor", 480, 720, 90, "3.222pF");
const c2 = place(doc, "capacitor", 960, 720, 90, "82.25pF");

/** Wire two pins together. */
const connect = (a: { id: string }, aPin: "p0" | "p1", b: { id: string }, bPin: "p0" | "p1") => {
  doc.edges.push({
    id: `e${doc.nextEdgeSeq++}`,
    from: { kind: "pin", componentId: a.id, pinId: aPin },
    to: { kind: "pin", componentId: b.id, pinId: bPin },
  });
};

connect(portIn, "p1", l2, "p0");
connect(l2, "p1", portOut, "p0");

// Route once so the trunk exists, then TAP the shunt caps onto it. This is the v2 feature:
// the junction is solved on the trunk, so the capacitor's stub is as short as geometry allows.
const firstPass = routeDocument(doc);
const trunkIds = doc.edges.map((e) => e.id);
let trunk = trunkIds[0];
for (const id of trunkIds) {
  if (firstPass.wires[id] && firstPass.wires[id].waypoints.length >= 2) {
    const pts = firstPass.wires[id].waypoints;
    const span = Math.abs(pts[pts.length - 1].x - pts[0].x);
    if (span > 600) trunk = id; // the long horizontal run between the two ends
  }
}
void trunk;

// Tap each capacitor's upper pin (p0 when rotated 90° points left; use p1 which points up).
const trunkPts = firstPass.wires[doc.edges[1].id].waypoints;
doc.edges.push({
  id: `e${doc.nextEdgeSeq++}`,
  from: { kind: "pin", componentId: c1.id, pinId: "p0" },
  to: { kind: "tap", edgeId: doc.edges[1].id, x: pinPos(c1, "p0").x, y: trunkPts[0].y },
});
doc.edges.push({
  id: `e${doc.nextEdgeSeq++}`,
  from: { kind: "pin", componentId: c2.id, pinId: "p0" },
  to: { kind: "tap", edgeId: doc.edges[1].id, x: pinPos(c2, "p0").x, y: trunkPts[0].y },
});

// Ground the lower ends of both capacitors by wiring them to each other and declaring the node
// as ground (one ground symbol is enough for both, and scikit-rf accepts a shared Ground).
connect(c1, "p1", c2, "p1");

// Declarations: the two ends are ports, the capacitor bottoms are ground.
doc.ports = [pinKey(portIn.id, "p0"), pinKey(portOut.id, "p1")];
doc.grounds = [pinKey(c1.id, "p1")];

// Solve and record geometry exactly as the editor does before saving.
const routed = routeDocument(doc);
const geometry: RlcDoc["geometry"] = {};
const parts: string[] = [];
for (const [id, w] of Object.entries(routed.wires)) {
  geometry[id] = { waypoints: w.waypoints, quality: w.quality };
  parts.push(`  ${id}: ${w.quality} ${w.waypoints.length}pts len=${w.waypoints.reduce(
    (n, p, i, arr) => (i === 0 ? 0 : n + Math.abs(p.x - arr[i - 1].x) + Math.abs(p.y - arr[i - 1].y)),
    0,
  )}`);
}
const finalDoc: RlcDoc = { ...doc, geometry };

const { netlist, warnings } = buildSkrfNetlist(finalDoc, {
  frequency: { start: 0.1, stop: 10, npoints: 1001, unit: "GHz" },
});

const outPath = resolve(process.cwd(), "netlist/example-lowpass.json");
writeFileSync(outPath, JSON.stringify(netlist, null, 2), "utf8");

console.log(`wrote ${outPath}`);
console.log(`components : ${finalDoc.components.map((c) => `${c.label}=${c.value}`).join(", ")}`);
console.log(`wires      :\n${parts.join("\n")}`);
console.log(`connections: ${JSON.stringify(netlist.connections)}`);
console.log(`networks   : ${netlist.networks.map((n) => `${n.name}(${n.kind})`).join(", ")}`);
console.log(`nets       : ${netlist.nets.map((n) => `${n.name}[${n.terminals.join(",")}]`).join(" ")}`);
console.log(`notes      : ${netlist.notes.length ? netlist.notes.join(" | ") : "(none)"}`);
console.log(`warnings   : ${warnings.length ? warnings.join(" | ") : "(none)"}`);
