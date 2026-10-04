/**
 * RLC editor canvas.
 *
 * Plain SVG, no diagram library: the interaction surface this editor needs is small
 * (drag a part, click pin→pin to wire, click a pin then a wire to TAP it, pan/zoom), and
 * owning the coordinate math is what lets the wire geometry, the hit tests and the routing
 * grid all agree exactly.
 *
 * Interaction contract:
 *   - drag a part body            → move (snapped to the lattice), wires re-route live
 *   - click a pin, then another   → connect (ESC or a click on empty canvas cancels)
 *   - click a part / wire         → select; Delete removes it (parts cascade to wires)
 *   - R / Shift+R                  → rotate selection by +90° / −90°
 *   - middle-drag or space-drag    → pan; wheel or +/− zooms
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pinPos, type Pt, type RlcComponent } from "./rlcModel";
import { labelAnchor, symbolGeometry } from "./rlcSymbols";
import { docBounds } from "./rlcGeometry";
import { GRID } from "./rlcConstants";
import { useRlcStore } from "./rlcStore";
import "./rlcEditorStyles.css";

const SELECT_COLOR = "#f97316";
const WIRE_COLOR = "#38bdf8";
const WIRE_TIGHT = "#a78bfa";
const WIRE_ESCAPE = "#fbbf24";
const PIN_R = 3.5;

const WIRE_STROKE: Record<string, string> = {
  clean: WIRE_COLOR,
  tight: WIRE_TIGHT,
  crowded: WIRE_TIGHT,
  escape: WIRE_ESCAPE,
};

interface View {
  x: number;
  y: number;
  k: number;
}

export function RlcEditorCanvas() {
  const doc = useRlcStore((s) => s.doc);
  const routes = useRlcStore((s) => s.routes);
  const degradedCount = useRlcStore((s) => s.degradedCount);
  const selected = useRlcStore((s) => s.selected);
  const selectedId = useRlcStore((s) => s.selectedId);
  const pendingPin = useRlcStore((s) => s.pendingPin);
  const previewPoint = useRlcStore((s) => s.previewPoint);
  const showGrid = useRlcStore((s) => s.showGrid);
  const placePart = useRlcStore((s) => s.placePart);
  const pendingPlaceKind = useRlcStore((s) => s.pendingPlaceKind);
  const consumePlaceRequest = useRlcStore((s) => s.consumePlaceRequest);
  const moveComponent = useRlcStore((s) => s.moveComponent);
  const rotateComponent = useRlcStore((s) => s.rotateComponent);
  const deleteSelection = useRlcStore((s) => s.deleteSelection);
  const select = useRlcStore((s) => s.select);
  const beginInteraction = useRlcStore((s) => s.beginInteraction);
  const startWire = useRlcStore((s) => s.startWire);
  const updatePreview = useRlcStore((s) => s.updatePreview);
  const completeWire = useRlcStore((s) => s.completeWire);
  const cancelWire = useRlcStore((s) => s.cancelWire);
  const endInteraction = useRlcStore((s) => s.endInteraction);
  const undo = useRlcStore((s) => s.undo);
  const redo = useRlcStore((s) => s.redo);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<
    | { kind: "component"; id: string; dx: number; dy: number; moved: boolean }
    | { kind: "pan"; startX: number; startY: number; originX: number; originY: number }
    | null
  >(null);
  const [dropKind, setDropKind] = useState<string | null>(null);

  // ── Coordinate conversion ─────────────────────────────────────────────────

  const toWorld = useCallback(
    (clientX: number, clientY: number): Pt => {
      const el = svgRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.k,
        y: (clientY - rect.top - view.y) / view.k,
      };
    },
    [view],
  );

  // ── Palette placement ────────────────────────────────────────────────────
  // The palette cannot compute a world position (it does not know the pan/zoom), so it
  // raises a request and the canvas resolves it here, in one effect, against the CURRENT
  // transform. Slots step 8 cells in X and 5 in Y so consecutive placements never stack.
  useEffect(() => {
    if (!pendingPlaceKind) return;
    consumePlaceRequest();
    const el = svgRef.current;
    const w = el?.clientWidth || 900;
    const h = el?.clientHeight || 600;
    const slotX = 8 * GRID;
    const slotY = 5 * GRID;
    const cols = 4;
    const n = doc.components.length;
    const col = n % cols;
    const row = Math.floor(n / cols);
    const world = {
      x: (w / 2 - view.x) / view.k + (col - (cols - 1) / 2) * slotX,
      y: (h / 2 - view.y) / view.k + row * slotY,
    };
    placePart(pendingPlaceKind, world.x, world.y);
  }, [pendingPlaceKind, consumePlaceRequest, doc.components.length, placePart, view]);

  // ── Fit to content ───────────────────────────────────────────────────────

  const bounds = useMemo(() => docBounds(doc), [doc]);
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current || doc.components.length === 0) return;
    const el = svgRef.current;
    if (!el) return;
    didFitRef.current = true;
    const w = el.clientWidth || 900;
    const h = el.clientHeight || 600;
    const pad = 96;
    const bw = Math.max(1, bounds.maxX - bounds.minX + pad * 2);
    const bh = Math.max(1, bounds.maxY - bounds.minY + pad * 2);
    // Only zoom in when the content is small; never shrink a large document on load.
    const k = Math.min(1, Math.max(0.25, Math.min(w / bw, h / bh)));
    setView({
      k,
      x: w / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
      y: h / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
    });
  }, [bounds, doc.components.length]);

  const fitView = useCallback(() => {
    const el = svgRef.current;
    if (!el) return;
    const w = el.clientWidth || 900;
    const h = el.clientHeight || 600;
    const pad = 80;
    const bw = Math.max(1, bounds.maxX - bounds.minX + pad * 2);
    const bh = Math.max(1, bounds.maxY - bounds.minY + pad * 2);
    const k = Math.min(1.5, Math.min(w / bw, h / bh));
    setView({
      k,
      x: w / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
      y: h / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
    });
  }, [bounds]);

  // ── Pointer handling ──────────────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const world = toWorld(e.clientX, e.clientY);
      const target = e.target as Element;
      // Handles are hit on the circle itself, but the symbol body is an SVG group whose
      // children (paths, hit rect) are the actual event targets — walk up to the nearest
      // annotated ancestor rather than reading the attribute off the target alone.
      const pinEl = target.closest?.("[data-pin-comp]") ?? null;
      const pinCompId = pinEl?.getAttribute("data-pin-comp") ?? null;
      const pinId = pinEl?.getAttribute("data-pin-id") as "p0" | "p1" | null;
      const compEl = target.closest?.("[data-comp]") ?? null;
      const compId = compEl?.getAttribute("data-comp") ?? null;
      const edgeEl = target.closest?.("[data-edge]") ?? null;
      const edgeId = edgeEl?.getAttribute("data-edge") ?? null;

      // Middle button or space held → pan.
      if (e.button === 1 || e.altKey) {
        dragRef.current = {
          kind: "pan",
          startX: e.clientX,
          startY: e.clientY,
          originX: view.x,
          originY: view.y,
        };
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return;
      }
      if (e.button !== 0) return;

      // A pin → start or finish a connection.
      if (pinCompId && pinId) {
        e.stopPropagation();
        if (pendingPin) {
          completeWire(pinCompId, pinId);
        } else {
          startWire(pinCompId, pinId);
          updatePreview(world);
        }
        return;
      }

      // A wire → select it (delete is then available from the panel or Delete key).
      if (edgeId && e.button === 0) {
        e.stopPropagation();
        if (pendingPin) {
          cancelWire();
        } else {
          select("edge", edgeId);
        }
        return;
      }

      // A component body → select + begin drag.
      if (compId) {
        e.stopPropagation();
        const comp = doc.components.find((c) => c.id === compId);
        if (comp) {
          select("component", compId);
          // One undo step per drag: snapshot now, edit transiently until pointer-up.
          beginInteraction();
          dragRef.current = {
            kind: "component",
            id: compId,
            dx: world.x - comp.x,
            dy: world.y - comp.y,
            moved: false,
          };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }
        return;
      }

      // Empty canvas: cancel a pending wire, else clear selection and start panning.
      if (pendingPin) {
        cancelWire();
        return;
      }
      select(null, null);
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        originX: view.x,
        originY: view.y,
      };
    },
    [beginInteraction, cancelWire, doc.components, completeWire, pendingPin, select, startWire, toWorld, updatePreview, view.x, view.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const world = toWorld(e.clientX, e.clientY);
      if (pendingPin) updatePreview(world);
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "pan") {
        setView((v) => ({ ...v, x: drag.originX + (e.clientX - drag.startX), y: drag.originY + (e.clientY - drag.startY) }));
        return;
      }
      // Note: no undo is pushed here — `beginInteraction()` already snapshotted the
      // document when the drag started, and the autosave happens on pointer-up.
      drag.moved = true;
      moveComponent(drag.id, world.x - drag.dx, world.y - drag.dy, { transient: true });
    },
    [moveComponent, pendingPin, toWorld, updatePreview],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      // A finished drag is one undo step and one autosave; a click that never moved
      // changes nothing and must not leave a no-op entry on the stack.
      if (drag && drag.kind === "component") {
        if (drag.moved) endInteraction();
        else useRlcStore.setState({ past: useRlcStore.getState().past.slice(0, -1) });
      }
    },
    [endInteraction],
  );

  // Wheel zoom (non-passive so preventDefault works).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0012);
        const k = Math.max(0.2, Math.min(3, v.k * factor));
        const scale = k / v.k;
        return { k, x: mx - (mx - v.x) * scale, y: my - (my - v.y) * scale };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Keyboard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        cancelWire();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === "r" || e.key === "R") {
        if (selected === "component" && selectedId) {
          e.preventDefault();
          rotateComponent(selectedId, e.shiftKey ? 270 : 90);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) }));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) }));
        return;
      }
      if (e.key === "f" || e.key === "F") fitView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelWire, deleteSelection, fitView, redo, rotateComponent, selected, selectedId, undo]);

  // ── Drag & drop from the palette ─────────────────────────────────────────

  const onDrop = useCallback(
    (e: React.DragEvent<SVGSVGElement>) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("application/x-rlc-kind") || dropKind;
      setDropKind(null);
      if (!kind) return;
      const world = toWorld(e.clientX, e.clientY);
      placePart(kind as "resistor" | "inductor" | "capacitor", world.x, world.y);
    },
    [dropKind, placePart, toWorld],
  );

  // ── Render helpers ───────────────────────────────────────────────────────

  const gridSize = GRID * view.k;
  const gridOpacity = Math.max(0.05, Math.min(0.35, view.k * 0.28));

  const renderComponent = (comp: RlcComponent) => {
    const geo = symbolGeometry(comp.kind);
    const isSelected = selected === "component" && selectedId === comp.id;
    const la = labelAnchor(comp.kind);
    // Transparent hit area over the symbol AND its labels. SVG shapes drawn with
    // `fill: none` are only pointer targets along their stroke, so without this the
    // middle of a part would not respond to select/drag at all.
    const hitTop = geo.bbox.top - 6;
    const hitBottom = Math.max(geo.bbox.bottom, la.value.y) + 8;
    const hitLeft = geo.bbox.left - 6;
    const hitRight = geo.bbox.right + 6;
    return (
      <g
        key={comp.id}
        transform={`translate(${comp.x} ${comp.y}) rotate(${comp.rotation})`}
        className={isSelected ? "rlc-symbol rlc-symbol-selected" : "rlc-symbol"}
      >
        {isSelected && (
          <rect
            x={hitLeft - 2}
            y={hitTop - 2}
            width={hitRight - hitLeft + 4}
            height={hitBottom - hitTop + 4}
            rx={4}
            className="rlc-selection"
          />
        )}
        <g data-comp={comp.id} className="rlc-body">
          <rect
            x={hitLeft}
            y={hitTop}
            width={hitRight - hitLeft}
            height={hitBottom - hitTop}
            fill="transparent"
            className="rlc-hit"
          />
          <path d={geo.leadIn} className="rlc-lead" />
          <path d={geo.leadOut} className="rlc-lead" />
          <path d={geo.body} className="rlc-outline" />
          {geo.extras.map((d, i) => (
            <path key={i} d={d} className="rlc-outline" />
          ))}
          <g transform={`rotate(${-comp.rotation})`} className="rlc-labels">
            <text x={la.label.x} y={la.label.y} textAnchor="middle" className="rlc-label">
              {comp.label}
            </text>
            <text x={la.value.x} y={la.value.y} textAnchor="middle" className="rlc-value">
              {comp.value}
            </text>
          </g>
        </g>
      </g>
    );
  };

  const renderPins = (comp: RlcComponent) => {
    const out: React.ReactElement[] = [];
    for (const pinId of ["p0", "p1"] as const) {
      const p = pinPos(comp, pinId);
      const hot =
        pendingPin?.componentId === comp.id && pendingPin.pinId === pinId ? "pending" : undefined;
      out.push(
        <circle
          key={`${comp.id}-${pinId}`}
          cx={p.x}
          cy={p.y}
          r={PIN_R + (hot ? 1.5 : 0)}
          data-pin-comp={comp.id}
          data-pin-id={pinId}
          className={`rlc-pin${hot ? " rlc-pin-pending" : ""}`}
        />,
      );
    }
    return out;
  };

  const renderWire = (edgeId: string) => {
    const r = routes[edgeId];
    if (!r) return null;
    const isSelected = selected === "edge" && selectedId === edgeId;
    return (
      <g key={edgeId}>
        <path d={r.svgPath} className="rlc-wire-hit" data-edge={edgeId} />
        <path
          d={r.svgPath}
          className={`rlc-wire${isSelected ? " rlc-wire-selected" : ""}`}
          style={r.quality === "clean" ? undefined : { stroke: WIRE_STROKE[r.quality] }}
          data-quality={r.quality}
        />
      </g>
    );
  };

  /** In-flight preview: a rubber-band line from the pending pin to the cursor. */
  const preview = useMemo(() => {
    if (!pendingPin || !previewPoint) return null;
    const comp = doc.components.find((c) => c.id === pendingPin.componentId);
    if (!comp) return null;
    const p = pinPos(comp, pendingPin.pinId);
    return (
      <g className="rlc-preview" pointerEvents="none">
        <line x1={p.x} y1={p.y} x2={previewPoint.x} y2={previewPoint.y} className="rlc-preview-line" />
        <circle cx={previewPoint.x} cy={previewPoint.y} r={3} className="rlc-preview-dot" />
      </g>
    );
  }, [doc.components, pendingPin, previewPoint]);

  return (
    <svg
      ref={svgRef}
      className="rlc-canvas"
      data-testid="rlc-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern
          id="rlc-grid"
          width={GRID}
          height={GRID}
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(${view.x % gridSize} ${view.y % gridSize}) scale(${view.k})`}
        >
          <path d={`M ${GRID} 0 H 0 V ${GRID}`} fill="none" className="rlc-grid-line" style={{ opacity: gridOpacity }} />
        </pattern>
      </defs>
      <rect
        x={0}
        y={0}
        width="100%"
        height="100%"
        fill={showGrid ? "url(#rlc-grid)" : "var(--rlc-bg)"}
        className="rlc-bg"
      />
      <g
        transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
        className="rlc-viewport"
        data-testid="rlc-viewport"
      >
        {doc.edges.map((e) => renderWire(e.id))}
        {doc.components.map((c) => renderComponent(c))}
        {doc.components.map((c) => renderPins(c))}
        {preview}
      </g>
      {degradedCount > 0 && (
        <g className="rlc-badge" transform="translate(12 12)" pointerEvents="none">
          <rect x={0} y={0} width={252} height={26} rx={4} className="rlc-badge-bg" />
          <text x={10} y={17} className="rlc-badge-text">
            {`⚠ ${degradedCount} 条连线未完全避开元件（已保持正交）`}
          </text>
        </g>
      )}
      <g className="rlc-hint" transform="translate(12 12)">
        <text x={0} y={-2}>{""}</text>
      </g>
    </svg>
  );
}

export { SELECT_COLOR, WIRE_COLOR };
