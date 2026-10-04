/**
 * RLC editor state store.
 *
 * Zustand store holding the RLC document plus the derived artifacts (routes, selection,
 * undo stack). Deliberately separate from the upstream AV store: this editor's whole
 * surface is R / L / C parts, four-way pins and orthogonal wires, and keeping the state
 * small is what makes the editing rules auditable.
 *
 * Every mutation is a pure transition on `RlcDoc` committed through `commit()`, which is
 * also the single place the undo stack, autosave and route recomputation are wired.
 *
 * ── GEOMETRY IS STORED, NOT JUST RECOMPUTED ─────────────────────────────────
 * `doc.geometry` holds each wire's solved polyline. When a file is opened, the canvas renders
 * THAT polyline, so the drawing is identical to what was saved — reopening a file never
 * quietly re-routes it into a different shape. A fresh solve is still run, but only to CHECK
 * the stored geometry; a disagreement is reported and the stored shape keeps being drawn
 * until the user explicitly asks for a re-route.
 */

import { create } from "zustand";
import {
  emptyRlcDoc,
  makeComponent,
  normalizeRotation,
  pinKey,
  removeComponents,
  removeEdges,
  type RlcDoc,
  type RlcEdge,
  type RlcEdgeEndpoint,
  type RlcKind,
  type RlcRotation,
  type RlcWireGeometry,
  type Pt,
} from "./rlcModel";
import { routeDocument, type RlcRoutedWire } from "./rlcRouting";
import { waypointsToSvgPath } from "../pathfinding";
import {
  DOC_VERSION,
  HISTORY_LIMIT,
  LS_KEY,
  WIRE_CORNER_RADIUS,
} from "./rlcConstants";
import { snapToGrid, type GridPos } from "./rlcGeometry";
import {
  buildSkrfNetlist,
  deriveNetlist,
  formatNetlistText,
  type SkrfFrequency,
} from "./rlcNetlist";

export type SelectionKind = "component" | "edge" | null;

/** Whether the geometry currently on screen was stored, verified, or freshly solved. */
export type GeometryStatus = "none" | "verified" | "mismatch" | "solved";

interface EditorState {
  doc: RlcDoc;
  routes: Record<string, RlcRoutedWire>;
  degradedCount: number;
  isRouting: boolean;
  geometryStatus: GeometryStatus;

  selected: SelectionKind;
  selectedId: string | null;
  /** Pin the user clicked first while drawing a wire, if any. */
  pendingPin: RlcEdgeEndpoint | null;
  /** Cursor position of the in-flight wire preview, in world pixels. */
  previewPoint: Pt | null;

  avoidWires: boolean;
  showGrid: boolean;

  /** A pending "place a part" request raised by the palette. The CANVAS consumes it: only
   *  the canvas knows the current pan/zoom, so only it can turn "the middle of the screen"
   *  into a world position. */
  pendingPlaceKind: RlcKind | null;
  requestPlace: (kind: RlcKind) => void;
  consumePlaceRequest: () => void;

  past: RlcDoc[];
  future: RlcDoc[];

  // ── Commands ───────────────────────────────────────────────────────────────
  placePart: (kind: RlcKind, x: number, y: number) => string;
  moveComponent: (id: string, x: number, y: number, opts?: { transient?: boolean }) => void;
  rotateComponent: (id: string, delta: 90 | 180 | 270) => void;
  deleteSelection: () => void;
  deleteEdge: (id: string) => void;
  setValue: (id: string, value: string) => void;
  setLabel: (id: string, label: string) => void;

  select: (kind: SelectionKind, id: string | null) => void;
  /** Mark the START of a multi-step interaction (a drag). */
  beginInteraction: () => void;
  startWire: (componentId: string, pinId: "p0" | "p1") => void;
  updatePreview: (pt: Pt | null) => void;
  completeWire: (componentId: string, pinId: "p0" | "p1") => void;
  cancelWire: () => void;
  /** Mark the END of a multi-step interaction: persist the transient edits. */
  endInteraction: () => void;

  /** Declare a node as a port / ground, or clear it. Keyed by pin key or net name. */
  togglePort: (netName: string) => void;
  toggleGround: (netName: string) => void;

  undo: () => void;
  redo: () => void;
  clearAll: () => void;
  /** Re-run the router and adopt the result, discarding stored geometry. */
  reroute: () => void;
  importDoc: (json: string) => { ok: boolean; error?: string };
  exportDoc: () => string;
  exportNetlist: (freq?: SkrfFrequency) => string;
  exportNetlistText: (freq?: SkrfFrequency) => string;
  netlistSummary: () => ReturnType<typeof deriveNetlist>;
  /** Derived netlist, recomputed only when the document changes (see the selector below). */
  netlist: () => ReturnType<typeof deriveNetlist>;
  setAvoidWires: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  recompute: () => void;
  loadFromLocalStorage: () => void;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Build the renderable wire objects from stored geometry (no solving involved). */
function routesFromGeometry(
  doc: RlcDoc,
): { routes: Record<string, RlcRoutedWire>; degradedCount: number } | null {
  const entries = Object.entries(doc.geometry);
  if (entries.length === 0) return null;
  const routes: Record<string, RlcRoutedWire> = {};
  let degradedCount = 0;
  for (const [id, g] of entries) {
    if (!doc.edges.some((e) => e.id === id)) continue;
    if (!g || !Array.isArray(g.waypoints) || g.waypoints.length < 2) continue;
    const degraded = g.quality !== "clean";
    if (degraded) degradedCount++;
    routes[id] = {
      edgeId: id,
      waypoints: g.waypoints.map((p) => ({ x: p.x, y: p.y })),
      svgPath: waypointsToSvgPath(g.waypoints, WIRE_CORNER_RADIUS),
      quality: (g.quality as RlcRoutedWire["quality"]) ?? "clean",
      degraded,
      turns: 0,
    };
  }
  // Partial stored geometry is not usable as "the" geometry: fall back to solving.
  if (Object.keys(routes).length !== doc.edges.length) return null;
  return { routes, degradedCount };
}

function recomputeRoutes(doc: RlcDoc, avoidWires: boolean) {
  const res = routeDocument(doc, { avoidWires });
  const geometry: Record<string, RlcWireGeometry> = {};
  for (const [id, w] of Object.entries(res.wires)) {
    geometry[id] = { waypoints: w.waypoints, quality: w.quality };
  }
  return { routes: res.wires, degradedCount: res.degradedCount, geometry };
}

/** True when stored and freshly solved geometry agree point for point. */
function geometryMatches(stored: RlcDoc["geometry"], fresh: RlcDoc["geometry"]): boolean {
  const ids = new Set([...Object.keys(stored), ...Object.keys(fresh)]);
  for (const id of ids) {
    const a = stored[id]?.waypoints;
    const b = fresh[id]?.waypoints;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
    }
  }
  return true;
}

// ── Import validation & migration ───────────────────────────────────────────

function isPinId(v: unknown): v is "p0" | "p1" {
  return v === "p0" || v === "p1";
}

/**
 * Normalise one endpoint.
 * Accepts the plain `{componentId, pinId}` shape, which is what both v1 and the current build
 * write. Anything else is rejected rather than guessed at.
 *
 * A document written by the experimental build that allowed a wire to end on ANOTHER wire
 * carries endpoints of that other shape; those are rejected here, and the loader reports them
 * so the user is told rather than shown a silently altered drawing.
 */
function normalizeEndpoint(raw: unknown): RlcEdgeEndpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // Reject anything that is not a pin endpoint, including the retired wire-anchored shape.
  if (r.kind !== undefined && r.kind !== "pin") return null;
  if (r.edgeId !== undefined) return null;
  if (typeof r.componentId !== "string" || !isPinId(r.pinId)) return null;
  return { componentId: r.componentId, pinId: r.pinId };
}

/**
 * Narrow validation for documents: reject anything the editor cannot render, and migrate the
 * v1 shape. Returns the migrated document plus whether any wire needed solving (which happens
 * when a document carries no stored geometry).
 */
function validateDoc(raw: unknown): { ok: true; doc: RlcDoc } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "不是 JSON 对象" };
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.components)) return { ok: false, error: "缺少 components 数组" };
  if (!Array.isArray(d.edges)) return { ok: false, error: "缺少 edges 数组" };
  const kinds: RlcKind[] = ["resistor", "inductor", "capacitor"];
  const ids = new Set<string>();
  for (const c of d.components as Record<string, unknown>[]) {
    if (typeof c?.id !== "string" || ids.has(c.id)) return { ok: false, error: `元件 id 非法或重复: ${String(c?.id)}` };
    ids.add(c.id);
    if (!kinds.includes(c.kind as RlcKind)) return { ok: false, error: `未知元件类型: ${String(c.kind)}` };
    if (![0, 90, 180, 270].includes(c.rotation as number)) return { ok: false, error: `旋转角非法: ${String(c.rotation)}` };
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return { ok: false, error: `坐标非法: ${c.id}` };
  }

  const rawEdges = d.edges as Record<string, unknown>[];
  for (const e of rawEdges) {
    if (typeof e?.id !== "string") return { ok: false, error: "连线缺少 id" };
  }
  const edgeIds = new Set(rawEdges.map((e) => e.id as string));

  const edges: RlcEdge[] = [];
  for (const e of rawEdges) {
    const from = normalizeEndpoint(e.from);
    const to = normalizeEndpoint(e.to);
    if (!from) return { ok: false, error: `连线 ${e.id} 起点非法（不支持接在另一条线上的接点）` };
    if (!to) return { ok: false, error: `连线 ${e.id} 终点非法（不支持接在另一条线上的接点）` };
    for (const end of [from, to]) {
      if (!ids.has(end.componentId)) {
        return { ok: false, error: `连线 ${e.id} 指向不存在的元件` };
      }
    }
    if (from.componentId === to.componentId && from.pinId === to.pinId) {
      return { ok: false, error: `连线 ${e.id} 两端是同一个引脚` };
    }
    edges.push({ id: e.id as string, from, to });
  }

  const order: RlcKind[] = ["resistor", "inductor", "capacitor"];
  const labelSeq: Record<RlcKind, number> = { resistor: 0, inductor: 0, capacitor: 0 };
  const rawLabelSeq = d.labelSeq;
  if (rawLabelSeq && typeof rawLabelSeq === "object") {
    for (const kind of order) {
      const v = (rawLabelSeq as Partial<Record<RlcKind, number>>)[kind];
      if (typeof v === "number" && Number.isFinite(v)) labelSeq[kind] = v;
    }
  }
  // Repair counters so a hand-edited file cannot mint a duplicate reference designator.
  const components = (d.components as Record<string, unknown>[]).map((c) => ({ ...c })) as unknown as RlcDoc["components"];
  for (const kind of order) {
    const used = components.filter((c) => c.kind === kind).length;
    labelSeq[kind] = Math.max(labelSeq[kind], used);
  }

  // Stored geometry: keep only entries that belong to a live wire and are well-formed.
  const geometry: Record<string, RlcWireGeometry> = {};
  const rawGeom = d.geometry;
  if (rawGeom && typeof rawGeom === "object") {
    for (const [id, g] of Object.entries(rawGeom as Record<string, unknown>)) {
      if (!edgeIds.has(id)) continue;
      const gg = g as Record<string, unknown>;
      if (!Array.isArray(gg?.waypoints) || (gg.waypoints as unknown[]).length < 2) continue;
      const pts = (gg.waypoints as Record<string, unknown>[]).filter(
        (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y),
      );
      if (pts.length < 2) continue;
      geometry[id] = {
        waypoints: pts.map((p) => ({ x: Number(p.x), y: Number(p.y) })),
        quality: typeof gg.quality === "string" ? gg.quality : "clean",
      };
    }
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    ok: true,
    doc: {
      version: DOC_VERSION,
      components,
      edges,
      nextComponentSeq:
        typeof d.nextComponentSeq === "number" && Number.isFinite(d.nextComponentSeq)
          ? d.nextComponentSeq
          : components.length + 1,
      nextEdgeSeq:
        typeof d.nextEdgeSeq === "number" && Number.isFinite(d.nextEdgeSeq)
          ? d.nextEdgeSeq
          : edges.length + 1,
      labelSeq,
      geometry,
      ports: strings(d.ports),
      grounds: strings(d.grounds),
      avoidWires: d.avoidWires === undefined ? true : Boolean(d.avoidWires),
    },
  };
}

function saveLocal(doc: RlcDoc): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(doc));
  } catch {
    // Quota or private mode: autosave is a convenience, never a hard failure.
  }
}

/** Read the autosaved document at module init. */
function hydrateFromLocalStorage(): RlcDoc {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyRlcDoc();
    const res = validateDoc(JSON.parse(raw));
    return res.ok ? res.doc : emptyRlcDoc();
  } catch {
    return emptyRlcDoc();
  }
}

export const useRlcStore = create<EditorState>((set, get) => {
  // ── Startup: prefer stored geometry, verify it, never silently replace it.
  const hydrated = hydrateFromLocalStorage();
  const stored = routesFromGeometry(hydrated);
  const fresh = recomputeRoutes(hydrated, hydrated.avoidWires);

  let startRoutes: Record<string, RlcRoutedWire>;
  let startDegraded: number;
  let startStatus: GeometryStatus;
  let startDoc = hydrated;

  if (hydrated.edges.length === 0) {
    startRoutes = {};
    startDegraded = 0;
    startStatus = "none";
  } else if (stored) {
    // Render what was saved; the fresh solve is only a check.
    startRoutes = stored.routes;
    startDegraded = stored.degradedCount;
    startStatus = geometryMatches(hydrated.geometry, fresh.geometry) ? "verified" : "mismatch";
  } else {
    // No stored geometry (a hand-written netlist): solve once and record it.
    startRoutes = fresh.routes;
    startDegraded = fresh.degradedCount;
    startStatus = "solved";
    startDoc = { ...hydrated, geometry: fresh.geometry };
  }

  /** Commit a new document: push undo, recompute routes, autosave. */
  const commit = (next: RlcDoc, opts: { transient?: boolean } = {}) => {
    const state = get();
    const r = recomputeRoutes(next, state.avoidWires);
    const doc: RlcDoc = { ...next, geometry: r.geometry };
    if (opts.transient) {
      set({ doc, routes: r.routes, degradedCount: r.degradedCount, geometryStatus: "none" });
      return;
    }
    const past = [...state.past, state.doc].slice(-HISTORY_LIMIT);
    set({ doc, past, future: [], routes: r.routes, degradedCount: r.degradedCount, geometryStatus: "none" });
    saveLocal(doc);
  };

  return {
    doc: startDoc,
    routes: startRoutes,
    degradedCount: startDegraded,
    isRouting: false,
    geometryStatus: startStatus,

    selected: null,
    selectedId: null,
    pendingPin: null,
    previewPoint: null,

    avoidWires: hydrated.avoidWires,
    showGrid: true,
    pendingPlaceKind: null,
    past: [],
    future: [],

    placePart: (kind, x, y) => {
      const state = get();
      const snapped: GridPos = { x: snapToGrid(x), y: snapToGrid(y) };
      const made = makeComponent(state.doc, kind, snapped.x, snapped.y, 0);
      const next: RlcDoc = {
        ...state.doc,
        components: [...state.doc.components, made.component],
        nextComponentSeq: made.doc.nextComponentSeq,
        labelSeq: made.doc.labelSeq,
      };
      commit(next);
      set({ selected: "component", selectedId: made.component.id });
      return made.component.id;
    },

    moveComponent: (id, x, y, opts) => {
      const state = get();
      const sx = snapToGrid(x);
      const sy = snapToGrid(y);
      const existing = state.doc.components.find((c) => c.id === id);
      if (!existing || (existing.x === sx && existing.y === sy)) return;
      const next: RlcDoc = {
        ...state.doc,
        components: state.doc.components.map((c) => (c.id === id ? { ...c, x: sx, y: sy } : c)),
      };
      commit(next, { transient: opts?.transient });
    },

    rotateComponent: (id, delta) => {
      const state = get();
      const existing = state.doc.components.find((c) => c.id === id);
      if (!existing) return;
      const next: RlcDoc = {
        ...state.doc,
        components: state.doc.components.map((c) =>
          c.id === id ? { ...c, rotation: normalizeRotation(c.rotation + delta) as RlcRotation } : c,
        ),
      };
      commit(next);
    },

    deleteSelection: () => {
      const state = get();
      const { selected, selectedId } = state;
      if (!selected || !selectedId) return;
      if (selected === "component") {
        // Removing a part also removes every wire attached to it.
        commit(removeComponents(state.doc, [selectedId]));
      } else {
        commit(removeEdges(state.doc, [selectedId]));
      }
      set({ selected: null, selectedId: null });
    },

    deleteEdge: (id) => {
      const state = get();
      commit(removeEdges(state.doc, [id]));
      if (state.selectedId === id) set({ selected: null, selectedId: null });
    },

    setValue: (id, value) => {
      const state = get();
      const next: RlcDoc = {
        ...state.doc,
        components: state.doc.components.map((c) => (c.id === id ? { ...c, value } : c)),
      };
      commit(next);
    },

    setLabel: (id, label) => {
      const state = get();
      const next: RlcDoc = {
        ...state.doc,
        components: state.doc.components.map((c) => (c.id === id ? { ...c, label } : c)),
      };
      commit(next);
    },

    select: (kind, id) => set({ selected: kind, selectedId: id }),

    beginInteraction: () => {
      const state = get();
      set({ past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [] });
    },

    startWire: (componentId, pinId) =>
      set({
        pendingPin: { componentId, pinId },
        selected: null,
        selectedId: null,
      }),

    updatePreview: (pt) => set({ previewPoint: pt }),

    completeWire: (componentId, pinId) => {
      const state = get();
      const pending = state.pendingPin;
      if (!pending) return;
      set({ pendingPin: null, previewPoint: null });
      if (pending.componentId === componentId && pending.pinId === pinId) return;
      const target: RlcEdgeEndpoint = { componentId, pinId };
      if (!canConnect(state.doc, pending, target)) return;
      commit(appendEdge(state.doc, pending, target));
    },

    cancelWire: () => set({ pendingPin: null, previewPoint: null }),

    endInteraction: () => {
      const state = get();
      saveLocal(state.doc);
    },

    togglePort: (netName) => {
      const state = get();
      const derived = deriveNetlist(state.doc);
      const net = derived.nets.find((n) => n.name === netName);
      if (!net) return;
      const already = derived.ports.find((p) => p.netName === netName);
      const ports = already
        ? state.doc.ports.filter((k) => k !== already.key)
        : [...state.doc.ports, net.terminals[0].key];
      commit({ ...state.doc, ports });
    },

    toggleGround: (netName) => {
      const state = get();
      const derived = deriveNetlist(state.doc);
      const net = derived.nets.find((n) => n.name === netName);
      if (!net) return;
      const already = derived.grounds.find((g) => g.netName === netName);
      const grounds = already
        ? state.doc.grounds.filter((k) => k !== already.key)
        : [...state.doc.grounds, net.terminals[0].key];
      commit({ ...state.doc, grounds });
    },

    undo: () => {
      const state = get();
      if (state.past.length === 0) return;
      const prev = state.past[state.past.length - 1];
      const r = recomputeRoutes(prev, state.avoidWires);
      const doc: RlcDoc = { ...prev, geometry: r.geometry };
      set({
        doc,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
        routes: r.routes,
        degradedCount: r.degradedCount,
        geometryStatus: "none",
        selected: null,
        selectedId: null,
        pendingPin: null,
      });
      saveLocal(doc);
    },

    redo: () => {
      const state = get();
      if (state.future.length === 0) return;
      const next = state.future[0];
      const r = recomputeRoutes(next, state.avoidWires);
      const doc: RlcDoc = { ...next, geometry: r.geometry };
      set({
        doc,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        routes: r.routes,
        degradedCount: r.degradedCount,
        geometryStatus: "none",
        selected: null,
        selectedId: null,
        pendingPin: null,
      });
      saveLocal(doc);
    },

    clearAll: () => {
      const state = get();
      const freshDoc = emptyRlcDoc();
      set({ past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [] });
      commit(freshDoc);
      set({
        selected: null,
        selectedId: null,
        pendingPin: null,
        previewPoint: null,
        geometryStatus: "none",
      });
    },

    reroute: () => {
      const state = get();
      const r = recomputeRoutes(state.doc, state.avoidWires);
      const doc: RlcDoc = { ...state.doc, geometry: r.geometry };
      set({ doc, routes: r.routes, degradedCount: r.degradedCount, geometryStatus: "none" });
      saveLocal(doc);
    },

    importDoc: (json) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        return { ok: false, error: `JSON 解析失败: ${(e as Error).message}` };
      }
      const res = validateDoc(parsed);
      if (!res.ok) return { ok: false, error: res.error };
      const state = get();
      const past = [...state.past, state.doc].slice(-HISTORY_LIMIT);

      // Honour stored geometry if the file carries it; otherwise solve and record.
      const storedRoutes = routesFromGeometry(res.doc);
      const fresh = recomputeRoutes(res.doc, res.doc.avoidWires);
      let doc = res.doc;
      let routes = fresh.routes;
      let degradedCount = fresh.degradedCount;
      let status: GeometryStatus = "solved";
      if (res.doc.edges.length === 0) {
        status = "none";
      } else if (storedRoutes) {
        routes = storedRoutes.routes;
        degradedCount = storedRoutes.degradedCount;
        status = geometryMatches(res.doc.geometry, fresh.geometry) ? "verified" : "mismatch";
      } else {
        doc = { ...res.doc, geometry: fresh.geometry };
      }

      set({
        doc,
        past,
        future: [],
        routes,
        degradedCount,
        geometryStatus: status,
        avoidWires: res.doc.avoidWires,
        selected: null,
        selectedId: null,
        pendingPin: null,
      });
      saveLocal(doc);
      return { ok: true };
    },

    exportDoc: () => JSON.stringify(get().doc, null, 2),

    exportNetlist: (freq) => {
      const state = get();
      const { netlist } = buildSkrfNetlist(state.doc, freq ? { frequency: freq } : {});
      return JSON.stringify(netlist, null, 2);
    },

    exportNetlistText: (freq) => {
      const { netlist } = buildSkrfNetlist(get().doc, freq ? { frequency: freq } : {});
      return formatNetlistText(netlist);
    },

    netlistSummary: () => deriveNetlist(get().doc),

    netlist: () => deriveNetlist(get().doc),

    setAvoidWires: (v) => {
      const state = get();
      const r = recomputeRoutes(state.doc, v);
      const doc: RlcDoc = { ...state.doc, avoidWires: v, geometry: r.geometry };
      set({ avoidWires: v, doc, routes: r.routes, degradedCount: r.degradedCount, geometryStatus: "none" });
      saveLocal(doc);
    },

    setShowGrid: (v) => set({ showGrid: v }),

    requestPlace: (kind) => set({ pendingPlaceKind: kind }),

    consumePlaceRequest: () => set({ pendingPlaceKind: null }),

    recompute: () => {
      const state = get();
      const r = recomputeRoutes(state.doc, state.avoidWires);
      const doc: RlcDoc = { ...state.doc, geometry: r.geometry };
      set({ doc, routes: r.routes, degradedCount: r.degradedCount });
      saveLocal(doc);
    },

    loadFromLocalStorage: () => {
      const restored = hydrateFromLocalStorage();
      const r = recomputeRoutes(restored, restored.avoidWires);
      const doc: RlcDoc = { ...restored, geometry: r.geometry };
      set({ doc, routes: r.routes, degradedCount: r.degradedCount, past: [], future: [], geometryStatus: "solved" });
    },
  };
});

// ── Pure helpers used by the store ──────────────────────────────────────────

/** Append an edge with the next free id. */
function appendEdge(doc: RlcDoc, from: RlcEdgeEndpoint, to: RlcEdgeEndpoint): RlcDoc {
  return {
    ...doc,
    edges: [...doc.edges, { id: `e${doc.nextEdgeSeq}`, from, to }],
    nextEdgeSeq: doc.nextEdgeSeq + 1,
  };
}

/**
 * Would this connection be legal?
 *
 * Two rules, both about the netlist being a TREE (which is what scikit-rf needs in order to
 * build a circuit without duplicate node references):
 *
 *   1. The exact same pair of pins must not already be wired.
 *   2. The two pins must not ALREADY be on the same node — that would close a loop. This is
 *      the rule that turns wiring two pins of an already-joined node into a no-op instead of
 *      a silent short.
 */
function canConnect(doc: RlcDoc, from: RlcEdgeEndpoint, to: RlcEdgeEndpoint): boolean {
  const same = (a: RlcEdgeEndpoint, b: RlcEdgeEndpoint) =>
    a.componentId === b.componentId && a.pinId === b.pinId;
  for (const e of doc.edges) {
    if ((same(e.from, from) && same(e.to, to)) || (same(e.to, from) && same(e.from, to))) return false;
  }

  // Union-find over pin/wire elements, then ask whether the two ends are already in one net.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (r === x) {
      if (!parent.has(x)) parent.set(x, x);
      return x;
    }
    const root = find(r);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const elemOf = (e: RlcEdgeEndpoint) => `p:${pinKey(e.componentId, e.pinId)}`;
  for (const e of doc.edges) {
    union(`w:${e.id}`, elemOf(e.from));
    union(`w:${e.id}`, elemOf(e.to));
  }
  return find(elemOf(from)) !== find(elemOf(to));
}
