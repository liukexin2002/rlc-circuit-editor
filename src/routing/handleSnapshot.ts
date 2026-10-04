/**
 * The single point where routing depends on React Flow / the DOM.
 *
 * `routeAllEdges` resolves each connection's endpoints from handle positions that only React Flow
 * knows (it measures them in the DOM). Rather than hand the router a live `ReactFlowInstance` — which
 * can't cross a Web Worker boundary — we snapshot the handle data into a plain, structured-cloneable
 * object on the main thread and pass THAT to the router. The router then runs anywhere (main thread,
 * worker, or headless Node harness) with no DOM coupling.
 *
 * The fields here are exactly what `getHandlePositions` (edgeRouter.ts) reads off
 * `rfInstance.getInternalNode(id)`: the node type, its absolute position, its measured height (for
 * stub-label handle centering), and each handle's box.
 */

import type { ReactFlowInstance } from "@xyflow/react";
import type { SchematicNode } from "../types";
import { GRID_SIZE } from "../gridConstants";

export interface SnapshotHandle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Max distance a DOM-measured handle center may sit from a grid line and still be treated as
 *  measurement noise. The port-layout MODEL (deviceHandleLayout) puts every device port center
 *  exactly on the 20px grid, but the RENDERED rows drift 1-3px (border-box rounding, sub-pixel
 *  transforms — e.g. a device measuring 159px against a 160px model). Rows are 20px apart, so a
 *  3px snap can only ever correct drift, never move a port to the wrong row. */
const PORT_SNAP_EPS = 3;

export interface NodeHandleData {
  type: string | undefined;
  positionAbsolute: { x: number; y: number };
  /** Used to center stub-label l/r handles exactly (the router special-cases these). */
  measuredHeight?: number;
  source: SnapshotHandle[];
  target: SnapshotHandle[];
}

/** Plain map nodeId → handle data. Structured-cloneable; safe to postMessage to a worker. */
export type HandleSnapshot = Record<string, NodeHandleData>;

const cleanHandles = (
  handles: ReadonlyArray<{ id?: string | null; x: number; y: number; width: number; height: number }> | null | undefined,
  absPos?: { x: number; y: number },
): SnapshotHandle[] =>
  (handles ?? [])
    .filter((h): h is SnapshotHandle => typeof h.id === "string")
    .map((h) => {
      let { x, y } = h;
      if (absPos) {
        // Snap the handle's ABSOLUTE center onto the routing grid when it's within noise
        // range — routing must see ports rigidly on-grid (jogs at endpoints come from
        // off-grid port offsets), and the model guarantees they are; only the DOM drifts.
        const cx = absPos.x + x + h.width / 2;
        const cy = absPos.y + y + h.height / 2;
        const sx = Math.round(cx / GRID_SIZE) * GRID_SIZE;
        const sy = Math.round(cy / GRID_SIZE) * GRID_SIZE;
        if (Math.abs(sx - cx) <= PORT_SNAP_EPS) x += sx - cx;
        if (Math.abs(sy - cy) <= PORT_SNAP_EPS) y += sy - cy;
      }
      return { id: h.id, x, y, width: h.width, height: h.height };
    });

/**
 * Extract the handle-bounds snapshot for the given nodes from a React Flow instance. Call on the
 * main thread (it reads DOM-measured internals); the result is a plain object you can hand to
 * `routeAllEdges` directly or postMessage to the routing worker. Nodes React Flow hasn't measured
 * yet are skipped — the router already tolerates missing endpoints.
 */
export function buildHandleSnapshot(
  nodes: SchematicNode[],
  rfInstance: ReactFlowInstance,
): HandleSnapshot {
  const snapshot: HandleSnapshot = {};
  for (const node of nodes) {
    const internal = rfInstance.getInternalNode(node.id);
    if (!internal) continue;
    const bounds = internal.internals.handleBounds;
    const positionAbsolute = {
      x: internal.internals.positionAbsolute.x,
      y: internal.internals.positionAbsolute.y,
    };
    // Device ports snap to the grid (model-true; DOM drift is noise). Stub-label handles are
    // re-derived from measuredHeight by the router, and stubs deliberately sit off-grid to
    // stay colinear with their port — don't snap anything else.
    const snapAbs = internal.type === "device" ? positionAbsolute : undefined;
    snapshot[node.id] = {
      type: internal.type,
      positionAbsolute,
      measuredHeight: internal.measured?.height as number | undefined,
      source: cleanHandles(bounds?.source, snapAbs),
      target: cleanHandles(bounds?.target, snapAbs),
    };
  }
  return snapshot;
}
