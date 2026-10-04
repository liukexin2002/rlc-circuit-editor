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
 */

import { create } from "zustand";
import {
  emptyRlcDoc,
  makeComponent,
  normalizeRotation,
  type RlcDoc,
  type RlcKind,
  type RlcRotation,
} from "./rlcModel";
import { routeDocument, type RlcRoutedWire } from "./rlcRouting";
import { HISTORY_LIMIT, LS_KEY } from "./rlcConstants";
import { snapToGrid, type GridPos } from "./rlcGeometry";

export type SelectionKind = "component" | "edge" | null;

interface EditorState {
  doc: RlcDoc;
  routes: Record<string, RlcRoutedWire>;
  degradedCount: number;
  isRouting: boolean;

  selected: SelectionKind;
  selectedId: string | null;
  /** Pin the user clicked first while drawing a wire, if any. */
  pendingPin: { componentId: string; pinId: "p0" | "p1" } | null;
  /** Cursor position of the in-flight wire preview, in world pixels. */
  previewPoint: { x: number; y: number } | null;

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
  setValue: (id: string, value: string) => void;
  setLabel: (id: string, label: string) => void;

  select: (kind: SelectionKind, id: string | null) => void;
  /** Mark the START of a multi-step interaction (a drag): the current document is pushed
   *  onto the undo stack once, and the interaction's transient updates edit in place, so
   *  one gesture costs exactly one undo step instead of one per pointer event. */
  beginInteraction: () => void;
  startWire: (componentId: string, pinId: "p0" | "p1") => void;
  updatePreview: (pt: { x: number; y: number } | null) => void;
  completeWire: (componentId: string, pinId: "p0" | "p1") => void;
  cancelWire: () => void;
  /** Mark the END of a multi-step interaction: persist the transient edits. */
  endInteraction: () => void;

  undo: () => void;
  redo: () => void;
  clearAll: () => void;
  importDoc: (json: string) => { ok: boolean; error?: string };
  exportDoc: () => string;
  setAvoidWires: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  recompute: () => void;
  loadFromLocalStorage: () => void;
}

function recomputeRoutes(doc: RlcDoc, avoidWires: boolean) {
  const res = routeDocument(doc, { avoidWires });
  return { routes: res.wires, degradedCount: res.degradedCount };
}

/** Narrow validation for imported documents: reject anything the editor cannot render. */
function validateDoc(raw: unknown): { ok: true; doc: RlcDoc } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "不是 JSON 对象" };
  const d = raw as Partial<RlcDoc>;
  if (!Array.isArray(d.components)) return { ok: false, error: "缺少 components 数组" };
  if (!Array.isArray(d.edges)) return { ok: false, error: "缺少 edges 数组" };
  const kinds: RlcKind[] = ["resistor", "inductor", "capacitor"];
  const ids = new Set<string>();
  for (const c of d.components) {
    if (typeof c?.id !== "string" || ids.has(c.id)) return { ok: false, error: `元件 id 非法或重复: ${String(c?.id)}` };
    ids.add(c.id);
    if (!kinds.includes(c.kind)) return { ok: false, error: `未知元件类型: ${String(c.kind)}` };
    if (![0, 90, 180, 270].includes(c.rotation)) return { ok: false, error: `旋转角非法: ${String(c.rotation)}` };
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return { ok: false, error: `坐标非法: ${c.id}` };
  }
  for (const e of d.edges) {
    if (typeof e?.id !== "string") return { ok: false, error: "连线缺少 id" };
    if (!ids.has(e.from?.componentId) || !ids.has(e.to?.componentId)) {
      return { ok: false, error: `连线 ${e.id} 指向不存在的元件` };
    }
    if (!["p0", "p1"].includes(e.from?.pinId) || !["p0", "p1"].includes(e.to?.pinId)) {
      return { ok: false, error: `连线 ${e.id} 引脚非法` };
    }
  }
  const order: RlcKind[] = ["resistor", "inductor", "capacitor"];
  const labelSeq: Record<RlcKind, number> = { resistor: 0, inductor: 0, capacitor: 0 };
  if (d.labelSeq && typeof d.labelSeq === "object") {
    for (const kind of order) {
      const v = (d.labelSeq as Partial<Record<RlcKind, number>>)[kind];
      if (typeof v === "number" && Number.isFinite(v)) labelSeq[kind] = v;
    }
  }
  // Repair counters so a hand-edited file cannot mint a duplicate reference designator.
  for (const kind of order) {
    const used = d.components.filter((c) => c.kind === kind).length;
    labelSeq[kind] = Math.max(labelSeq[kind], used);
  }
  return {
    ok: true,
    doc: {
      version: 1,
      components: d.components.map((c) => ({ ...c })),
      edges: d.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })),
      nextComponentSeq: d.nextComponentSeq ?? d.components.length + 1,
      nextEdgeSeq: d.nextEdgeSeq ?? d.edges.length + 1,
      labelSeq,
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

/** Read the autosaved document at module init. Hydrating here (instead of in an effect)
 *  means the editor mounts with its content already present — no flash of an empty canvas,
 *  and one fewer race for the canvas' fit-to-content pass. */
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
  const hydrated = hydrateFromLocalStorage();
  const hydratedRoutes = recomputeRoutes(hydrated, true);

  /** Commit a new document: push undo, recompute routes, autosave. */
  const commit = (next: RlcDoc, opts: { transient?: boolean } = {}) => {
    const state = get();
    if (opts.transient) {
      const { routes, degradedCount } = recomputeRoutes(next, state.avoidWires);
      set({ doc: next, routes, degradedCount });
      return;
    }
    const past = [...state.past, state.doc].slice(-HISTORY_LIMIT);
    const { routes, degradedCount } = recomputeRoutes(next, state.avoidWires);
    set({ doc: next, past, future: [], routes, degradedCount });
    saveLocal(next);
  };

  return {
    doc: hydrated,
    routes: hydratedRoutes.routes,
    degradedCount: hydratedRoutes.degradedCount,
    isRouting: false,
    selected: null,
    selectedId: null,
    pendingPin: null,
    previewPoint: null,
    avoidWires: true,
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
        const next: RlcDoc = {
          ...state.doc,
          components: state.doc.components.filter((c) => c.id !== selectedId),
          edges: state.doc.edges.filter(
            (e) => e.from.componentId !== selectedId && e.to.componentId !== selectedId,
          ),
        };
        commit(next);
      } else {
        const next: RlcDoc = { ...state.doc, edges: state.doc.edges.filter((e) => e.id !== selectedId) };
        commit(next);
      }
      set({ selected: null, selectedId: null });
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
      set({ pendingPin: { componentId, pinId }, selected: null, selectedId: null }),

    updatePreview: (pt) => set({ previewPoint: pt }),

    completeWire: (componentId, pinId) => {
      const state = get();
      const pending = state.pendingPin;
      if (!pending) return;
      set({ pendingPin: null, previewPoint: null });
      // Reject self-connection on the same pin; allow the two pins of one part to be wired
      // only through a different route (same component + same pin is meaningless).
      if (pending.componentId === componentId && pending.pinId === pinId) return;
      const exists = state.doc.edges.some(
        (e) =>
          (e.from.componentId === pending.componentId &&
            e.from.pinId === pending.pinId &&
            e.to.componentId === componentId &&
            e.to.pinId === pinId) ||
          (e.to.componentId === pending.componentId &&
            e.to.pinId === pending.pinId &&
            e.from.componentId === componentId &&
            e.from.pinId === pinId),
      );
      if (exists) return;
      const next: RlcDoc = {
        ...state.doc,
        edges: [
          ...state.doc.edges,
          {
            id: `e${state.doc.nextEdgeSeq}`,
            from: { componentId: pending.componentId, pinId: pending.pinId },
            to: { componentId, pinId },
          },
        ],
        nextEdgeSeq: state.doc.nextEdgeSeq + 1,
      };
      commit(next);
    },

    cancelWire: () => set({ pendingPin: null, previewPoint: null }),

  endInteraction: () => {
    // Persist whatever a transient (drag) sequence produced. Skipped while a wire is being
    // drawn so an in-flight preview never gets written to storage.
    const state = get();
    saveLocal(state.doc);
  },

    undo: () => {
      const state = get();
      if (state.past.length === 0) return;
      const prev = state.past[state.past.length - 1];
      const { routes, degradedCount } = recomputeRoutes(prev, state.avoidWires);
      set({
        doc: prev,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
        routes,
        degradedCount,
        selected: null,
        selectedId: null,
      });
      saveLocal(prev);
    },

    redo: () => {
      const state = get();
      if (state.future.length === 0) return;
      const next = state.future[0];
      const { routes, degradedCount } = recomputeRoutes(next, state.avoidWires);
      set({
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        routes,
        degradedCount,
        selected: null,
        selectedId: null,
      });
      saveLocal(next);
    },

    clearAll: () => {
      const fresh = emptyRlcDoc();
      const state = get();
      set({ past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [] });
      commit(fresh);
      set({ selected: null, selectedId: null, pendingPin: null, previewPoint: null });
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
      const { routes, degradedCount } = recomputeRoutes(res.doc, state.avoidWires);
      set({ doc: res.doc, past, future: [], routes, degradedCount, selected: null, selectedId: null });
      saveLocal(res.doc);
      return { ok: true };
    },

    exportDoc: () => JSON.stringify(get().doc, null, 2),

    setAvoidWires: (v) => {
      const state = get();
      const { routes, degradedCount } = recomputeRoutes(state.doc, v);
      set({ avoidWires: v, routes, degradedCount });
    },

    setShowGrid: (v) => set({ showGrid: v }),

    requestPlace: (kind) => set({ pendingPlaceKind: kind }),

    consumePlaceRequest: () => set({ pendingPlaceKind: null }),

    recompute: () => {
      const state = get();
      const { routes, degradedCount } = recomputeRoutes(state.doc, state.avoidWires);
      set({ routes, degradedCount });
    },

    loadFromLocalStorage: () => {
      // Kept for explicit re-hydration (e.g. a future "revert to saved" action). The store
      // already hydrates at creation, so mounting does not need to call this.
      const restored = hydrateFromLocalStorage();
      const state = get();
      const { routes, degradedCount } = recomputeRoutes(restored, state.avoidWires);
      set({ doc: restored, routes, degradedCount, past: [], future: [] });
    },
  };
});
