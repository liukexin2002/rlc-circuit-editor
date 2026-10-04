/**
 * Netlist derivation + scikit-rf export.
 *
 * A netlist is DERIVED from the document, never stored: the drawing is the single source of
 * truth, and a second copy could disagree with it. Everything here is a pure function, so the
 * netlist can be asserted in Node without a store or a DOM.
 *
 * ── Why the derivation is a union-find ─────────────────────────────────────
 * A node is a set of pins that are electrically tied together, and a wire ties its two ends
 * together. So every wire is unioned with the two pins it lands on, and the resulting
 * components ARE the nets. A pin reached by several wires is still one terminal of its node,
 * because scikit-rf rejects a `(network, port)` pair that appears twice.
 *
 * ── scikit-rf shape ─────────────────────────────────────────────────────────
 * The exported `connections` is the structure scikit-rf's Circuit takes: a List of List of
 * `(network, port_number)`, where each inner list is one electrical node (all its members are
 * tied together). Ports and grounds are separate 1-port entries, which is exactly what
 * `Circuit.Port` / `Circuit.Ground` produce on the Python side.
 */

import {
  pinKey,
  type RlcDoc,
  type RlcEdge,
  type RlcEdgeEndpoint,
  type RlcKind,
} from "./rlcModel";
import { EDITOR_VERSION, ROUTING_MODEL } from "./rlcConstants";

// ── SI value parsing ────────────────────────────────────────────────────────

/** SI prefix multipliers used by component value labels. */
const SI: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

/** Unit text that may trail a value; ignored by the parser. */
const UNIT_SUFFIX: Record<RlcKind, string[]> = {
  resistor: ["ohm", "Ω", "R"],
  inductor: ["H", "h"],
  capacitor: ["F", "f"],
};

/**
 * Parse a displayed component value into an SI number.
 *
 * Accepts the forms a schematic actually uses: `10k`, `4.7k`, `100nF`, `2.2uH`, `50`,
 * `1M`, `1.5e3`. Returns null when the text cannot be read as a value, and callers surface
 * that as a note rather than guessing a number — a wrong component value in an exported
 * netlist is worse than an admitted gap.
 */
export function parseSiValue(text: string, kind: RlcKind): number | null {
  let s = String(text ?? "").trim();
  if (!s) return null;
  // Drop a trailing unit, longest-first so "ohm" beats "R" and "F" doesn't eat "nF".
  for (const u of [...UNIT_SUFFIX[kind]].sort((a, b) => b.length - a.length)) {
    if (u.length && s.toLowerCase().endsWith(u.toLowerCase()) && s.length > u.length) {
      s = s.slice(0, -u.length);
      break;
    }
  }
  // Scientific notation: parse as a plain number.
  if (/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // <number><prefix>[unit]
  const m = /^([+-]?\d*\.?\d+)\s*([a-zA-Zµμ])\s*([a-zA-ZΩ]*)$/.exec(s);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = SI[m[2]];
  if (mult === undefined) return null;
  return base * mult;
}

/** Format an SI number back into a compact label (for round-tripping an import). */
export function formatSiValue(v: number, kind: RlcKind): string {
  if (!Number.isFinite(v)) return "";
  const unit = kind === "resistor" ? "Ω" : kind === "inductor" ? "H" : "F";
  if (v === 0) return `0${unit}`;
  const mag = Math.abs(v);
  const table: [number, string][] = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "u"],
    [1e-9, "n"],
    [1e-12, "p"],
  ];
  for (const [scale, prefix] of table) {
    if (mag >= scale) {
      const n = v / scale;
      // Three significant decimals is plenty and avoids 10000.000000000002 style noise.
      const s = Number(n.toFixed(6)).toString();
      return `${s}${prefix}${unit}`;
    }
  }
  return `${v}${unit}`;
}

// ── Union-find ──────────────────────────────────────────────────────────────

class DSU {
  private parent = new Map<string, string>();

  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    // Path compression, iterative to avoid recursion depth on long chains.
    let root = x;
    while (true) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur) ?? root;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ── Netlist model ───────────────────────────────────────────────────────────

/** Stable key for a wire in the union-find element space. */
function wireElem(edgeId: string): string {
  return `w:${edgeId}`;
}

/** Stable key for a pin in the union-find element space. */
function pinElem(componentId: string, pinId: "p0" | "p1"): string {
  return `p:${pinKey(componentId, pinId)}`;
}

export interface RlcNetTerminal {
  /** Pin key, e.g. `n1.p1`. */
  key: string;
  componentId: string;
  componentName: string;
  pinId: "p0" | "p1";
}

export interface RlcNet {
  /** Deterministic name N1..Nk. */
  name: string;
  terminals: RlcNetTerminal[];
  /** Wire ids in this net, in numeric id order. */
  wires: string[];
  /** Manhattan length of every wire in the net, in world px. */
  length: number;
  /** True when the net has exactly one terminal (an unterminated stub). */
  dangling: boolean;
  /**
   * Tree check: a net built by connecting terminals without redundancy satisfies
   * `wires === terminals - 1`. More wires means the same two nodes are joined twice, which
   * scikit-rf would reject as a duplicate `(network, port)` node. Fewer means the derivation
   * is inconsistent. Reported per net so the UI can explain exactly what is wrong.
   */
  isTree: boolean;
}

export interface RlcNetlist {
  nets: RlcNet[];
  /** Ports and grounds declared by the user, as pin keys. */
  ports: { key: string; netName: string }[];
  grounds: { key: string; netName: string }[];
  /** Problems worth telling the user about, phrased for a person. */
  warnings: string[];
}

function edgeLength(doc: RlcDoc, e: RlcEdge): number {
  const g = doc.geometry[e.id]?.waypoints;
  if (!g || g.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < g.length; i++) n += Math.abs(g[i].x - g[i - 1].x) + Math.abs(g[i].y - g[i - 1].y);
  return n;
}

/** The element a wire endpoint attaches to: the pin it lands on. */
function elementOf(end: RlcEdgeEndpoint): string {
  return pinElem(end.componentId, end.pinId);
}

/**
 * Derive the netlist of a document.
 *
 * Every wire is unioned with the two PINS its ends land on, so two wires that share a pin are
 * on one node. A pin reached by more than one wire stays a single terminal of that node — a
 * duplicate `(network, port)` pair is rejected outright by scikit-rf.
 */
export function deriveNetlist(doc: RlcDoc): RlcNetlist {
  const dsu = new DSU();

  for (const e of doc.edges) {
    dsu.find(wireElem(e.id)); // ensure the wire exists as an element even if isolated
    for (const end of [e.from, e.to]) {
      const elem = elementOf(end);
      dsu.find(elem);
      dsu.union(wireElem(e.id), elem);
    }
  }

  // Group elements by root.
  const byRoot = new Map<string, { pins: RlcNetTerminal[]; wires: string[] }>();
  const bucket = (root: string) => {
    let b = byRoot.get(root);
    if (!b) {
      b = { pins: [], wires: [] };
      byRoot.set(root, b);
    }
    return b;
  };

  const compById = new Map(doc.components.map((c) => [c.id, c]));
  const seenTerminal = new Set<string>();
  for (const e of doc.edges) {
    const b = bucket(dsu.find(wireElem(e.id)));
    b.wires.push(e.id);
    for (const end of [e.from, e.to]) {
      const key = pinKey(end.componentId, end.pinId);
      if (seenTerminal.has(key)) continue;
      seenTerminal.add(key);
      const comp = compById.get(end.componentId);
      b.pins.push({
        key,
        componentId: end.componentId,
        componentName: comp?.label ?? end.componentId,
        pinId: end.pinId,
      });
    }
  }

  // Deterministic ordering: nets are numbered by their smallest wire id (numeric), so adding
  // an unrelated net never renumbers the existing ones.
  const roots = [...byRoot.keys()].sort((a, b) => {
    const wa = byRoot.get(a)!.wires.slice().sort(compareEdgeIds)[0] ?? "";
    const wb = byRoot.get(b)!.wires.slice().sort(compareEdgeIds)[0] ?? "";
    return compareEdgeIds(wa, wb);
  });

  const nets: RlcNet[] = [];
  const keyToNet = new Map<string, string>();
  roots.forEach((root, i) => {
    const b = byRoot.get(root)!;
    const wires = b.wires.slice().sort(compareEdgeIds);
    const pins = b.pins.slice().sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const name = `N${i + 1}`;
    for (const p of pins) keyToNet.set(p.key, name);
    nets.push({
      name,
      terminals: pins,
      wires,
      length: wires.reduce((n, id) => n + edgeLength(doc, doc.edges.find((e) => e.id === id)!), 0),
      dangling: pins.length === 1,
      isTree: wires.length === pins.length - 1,
    });
  });

  // A pin that no wire reaches is its own single-terminal net, so the netlist still lists it.
  for (const c of doc.components) {
    for (const pinId of ["p0", "p1"] as const) {
      const key = pinKey(c.id, pinId);
      if (keyToNet.has(key)) continue;
      const name = `N${nets.length + 1}`;
      keyToNet.set(key, name);
      nets.push({
        name,
        terminals: [{ key, componentId: c.id, componentName: c.label, pinId }],
        wires: [],
        length: 0,
        dangling: true,
        isTree: true,
      });
    }
  }

  const warnings: string[] = [];
  for (const n of nets) {
    if (!n.isTree) {
      warnings.push(
        `${n.name} 存在冗余连接（${n.wires.length} 条连线 / ${n.terminals.length} 个端子）：同一对端子被连接多次，scikit-rf 会视为重复节点。`,
      );
    }
  }

  const ports: { key: string; netName: string }[] = [];
  const grounds: { key: string; netName: string }[] = [];
  const validKeys = new Set(keyToNet.keys());
  for (const k of doc.ports) {
    if (!validKeys.has(k)) continue;
    const netName = keyToNet.get(k)!;
    if (ports.some((p) => p.netName === netName)) continue; // one port per node
    ports.push({ key: k, netName });
  }
  for (const k of doc.grounds) {
    if (!validKeys.has(k)) continue;
    const netName = keyToNet.get(k)!;
    if (grounds.some((g) => g.netName === netName)) continue;
    grounds.push({ key: k, netName });
  }
  // A one-terminal net that is neither port nor ground is an open stub. In RF that is
  // normally where the excitation sits, so it is promoted to a port — but only when the user
  // has not already declared a port, and the promotion is reported.
  if (ports.length === 0) {
    for (const n of nets) {
      if (n.dangling && !grounds.some((g) => g.netName === n.name)) {
        ports.push({ key: n.terminals[0].key, netName: n.name });
        break;
      }
    }
  }
  if (ports.length === 0) {
    warnings.push("没有定义任何端口（Port）：请在网表面板将某个节点标记为端口，或留下一个单端子的悬空节点。");
  }

  return { nets, ports, grounds, warnings };
}

/** Numeric-aware edge id comparison (`e9` before `e10`). */
export function compareEdgeIds(a: string, b: string): number {
  const na = /^(.*?)(\d+)$/.exec(a);
  const nb = /^(.*?)(\d+)$/.exec(b);
  if (na && nb && na[1] === nb[1]) return Number(na[2]) - Number(nb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── scikit-rf export ────────────────────────────────────────────────────────

export interface SkrfFrequency {
  start: number;
  stop: number;
  npoints: number;
  unit: string;
}

export interface SkrfNetworkEntry {
  name: string;
  kind: "resistor" | "inductor" | "capacitor" | "port" | "ground";
  /** SI value: Ω for resistors, H for inductors, F for capacitors. */
  value?: number;
  /** The label as shown in the editor, so a reimport can restore it verbatim. */
  value_text?: string;
  z0?: number;
}

export interface SkrfEdgeEnd {
  componentId: string;
  pinId: "p0" | "p1";
}

export interface SkrfSchematic {
  components: {
    id: string;
    name: string;
    kind: RlcKind;
    x: number;
    y: number;
    rotation: number;
    value_text: string;
  }[];
  wires: {
    id: string;
    from: SkrfEdgeEnd;
    to: SkrfEdgeEnd;
    /** Stored polyline — what makes reopening this file render EXACTLY the saved drawing. */
    waypoints: { x: number; y: number }[];
    quality: string;
  }[];
  ports: string[];
  grounds: string[];
  avoidWires: boolean;
}

export interface SkrfNetlist {
  format: string;
  generator: { app: string; version: string; routing: string };
  frequency: SkrfFrequency;
  /** scikit-rf `Circuit(connections)` input: List of List of (network, port_number). */
  connections: [string, number][][];
  networks: SkrfNetworkEntry[];
  schematic: SkrfSchematic;
  nets: {
    name: string;
    terminals: string[];
    wires: string[];
    length: number;
  }[];
  notes: string[];
}

export const NETLIST_FORMAT = "rlc-schematic-netlist/2";

/** Replace characters scikit-rf network names cannot carry, keeping them unique. */
function netName(label: string, used: Set<string>): string {
  let base = label.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(base)) base = `X_${base}`;
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}_${i++}`;
  used.add(name);
  return name;
}

/**
 * Build a scikit-rf netlist from a document.
 *
 * The exported structure carries BOTH the electrical connection list and the drawing
 * (`schematic`), so a reimport reproduces the saved picture instead of re-deriving it. The
 * Python loader ignores `schematic`; the editor uses it.
 */
export function buildSkrfNetlist(
  doc: RlcDoc,
  opts: { frequency?: SkrfFrequency } = {},
): { netlist: SkrfNetlist; warnings: string[] } {
  const frequency = opts.frequency ?? { start: 1, stop: 10, npoints: 1001, unit: "GHz" };
  const derived = deriveNetlist(doc);
  const used = new Set<string>();
  const notes: string[] = [];
  const warnings = [...derived.warnings];

  // ── Networks: one per component, plus one per port / ground.
  const networks: SkrfNetworkEntry[] = [];
  const nameByComponentId = new Map<string, string>();
  for (const c of doc.components) {
    const name = netName(c.label, used);
    nameByComponentId.set(c.id, name);
    const value = parseSiValue(c.value, c.kind);
    if (value === null) {
      notes.push(`${c.label} 的参数值 “${c.value}” 无法解析为数值，已省略其 value 字段。`);
    }
    networks.push({ name, kind: c.kind, value: value ?? undefined, value_text: c.value });
  }
  const portNetByNetName = new Map<string, string>();
  derived.ports.forEach((p, i) => {
    const name = netName(`PORT${i + 1}`, used);
    portNetByNetName.set(p.netName, name);
    networks.push({ name, kind: "port", z0: 50 });
  });
  const groundNetByNetName = new Map<string, string>();
  derived.grounds.forEach((g, i) => {
    const name = netName(`GND${i + 1}`, used);
    groundNetByNetName.set(g.netName, name);
    networks.push({ name, kind: "ground" });
  });

  // ── Connections: one inner list per net; each member is (network name, port index).
  //
  // A component's port index is 0 for p0 and 1 for p1, matching the pin ids. A port or ground
  // is a 1-port network, so its index is always 0.
  const portIndexOf = (pinId: "p0" | "p1") => (pinId === "p0" ? 0 : 1);
  const connections: [string, number][][] = [];
  for (const net of derived.nets) {
    const members: [string, number][] = [];
    for (const t of net.terminals) {
      const netNameOfComp = nameByComponentId.get(t.componentId);
      if (!netNameOfComp) continue;
      members.push([netNameOfComp, portIndexOf(t.pinId)]);
    }
    const p = portNetByNetName.get(net.name);
    if (p) members.push([p, 0]);
    const g = groundNetByNetName.get(net.name);
    if (g) members.push([g, 0]);
    if (members.length === 0) continue;
    // Deterministic order inside a node.
    members.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    connections.push(members);
  }

  // ── Structural validation against scikit-rf's own rules.
  const allNames = networks.map((n) => n.name);
  if (new Set(allNames).size !== allNames.length) {
    warnings.push("存在重名的网络（scikit-rf 要求每个 Network 名称唯一）。");
  }
  const seenNodes = new Set<string>();
  for (const group of connections) {
    if (group.length === 0) warnings.push("存在空的连接组。");
    for (const [n, p] of group) {
      const key = `${n}#${p}`;
      if (seenNodes.has(key)) {
        warnings.push(`节点 ${n} 的端口 ${p} 出现在多个连接组中（scikit-rf 会拒绝重复节点）。`);
      }
      seenNodes.add(key);
      const entry = networks.find((x) => x.name === n);
      if (!entry) {
        warnings.push(`连接引用了不存在的网络 ${n}。`);
      } else if (p !== 0 && entry.kind !== "resistor" && entry.kind !== "inductor" && entry.kind !== "capacitor") {
        warnings.push(`${n} 是 1 端口网络，却引用了端口 ${p}。`);
      }
    }
  }

  const schematic: SkrfSchematic = {
    components: doc.components.map((c) => ({
      id: c.id,
      name: nameByComponentId.get(c.id) ?? c.label,
      kind: c.kind,
      x: c.x,
      y: c.y,
      rotation: c.rotation,
      value_text: c.value,
    })),
    wires: doc.edges.map((e) => ({
      id: e.id,
      from: { componentId: e.from.componentId, pinId: e.from.pinId },
      to: { componentId: e.to.componentId, pinId: e.to.pinId },
      waypoints: (doc.geometry[e.id]?.waypoints ?? []).map((p) => ({ x: p.x, y: p.y })),
      quality: doc.geometry[e.id]?.quality ?? "unknown",
    })),
    ports: [...doc.ports],
    grounds: [...doc.grounds],
    avoidWires: doc.avoidWires,
  };

  const netlist: SkrfNetlist = {
    format: NETLIST_FORMAT,
    generator: { app: "rlc-editor", version: EDITOR_VERSION, routing: ROUTING_MODEL },
    frequency,
    connections,
    networks,
    schematic,
    nets: derived.nets.map((n) => ({
      name: n.name,
      terminals: n.terminals.map((t) => t.key),
      wires: n.wires,
      length: n.length,
    })),
    notes,
  };

  return { netlist, warnings };
}

/** Human-readable text form of a netlist, for copying into a Python session. */
export function formatNetlistText(netlist: SkrfNetlist): string {
  const lines: string[] = [];
  lines.push(`# ${NETLIST_FORMAT} — 由 RLC 电路图编辑器 v${EDITOR_VERSION} 导出`);
  lines.push(`# 频率: ${netlist.frequency.start}–${netlist.frequency.stop} ${netlist.frequency.unit}, ${netlist.frequency.npoints} 点`);
  lines.push("");
  lines.push("# 元件");
  for (const n of netlist.networks) {
    if (n.kind === "port" || n.kind === "ground") continue;
    const unit = n.kind === "resistor" ? "Ω" : n.kind === "inductor" ? "H" : "F";
    lines.push(`#   ${n.name.padEnd(8)} ${n.kind.padEnd(10)} ${String(n.value ?? "?").padEnd(12)} ${unit}   (${n.value_text ?? ""})`);
  }
  if (netlist.networks.some((n) => n.kind === "port" || n.kind === "ground")) {
    lines.push("# 端口 / 地");
    for (const n of netlist.networks) {
      if (n.kind !== "port" && n.kind !== "ground") continue;
      lines.push(`#   ${n.name.padEnd(8)} ${n.kind}`);
    }
  }
  lines.push("");
  lines.push("# connections —— 每个内层列表是一个电气节点");
  lines.push("connections = [");
  for (const group of netlist.connections) {
    const body = group.map(([n, p]) => `(${n}, ${p})`).join(", ");
    lines.push(`    [${body}],`);
  }
  lines.push("]");
  lines.push("");
  lines.push("# 网络");
  for (const n of netlist.nets) {
    const lenText = n.length ? `，长度 ${n.length}px` : "";
    lines.push(`#   ${n.name.padEnd(5)} 端子 [${n.terminals.join(", ")}]  连线 [${n.wires.join(", ")}]${lenText}`);
  }
  if (netlist.notes.length) {
    lines.push("");
    lines.push("# 备注");
    for (const n of netlist.notes) lines.push(`#   ${n}`);
  }
  return lines.join("\n");
}
