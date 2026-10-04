/**
 * A fake ReactFlowInstance exposing just `getInternalNode`, the one method
 * routeAllEdges/getHandlePositions calls. Handle bounds are synthesized from the
 * port layout (see deviceHandleLayout) so routing runs headless in Node.
 *
 * getHandlePositions (edgeRouter.ts) recovers a handle center as
 *   absX + bound.x + bound.width/2 ,  absY + bound.y + bound.height/2
 * so for a center at node-local (cx, cy) with width/height 10 we emit x=cx-5, y=cy-5.
 * Stub-label l/r handles get their Y from internal.measured.height directly (the router
 * special-cases them), so only width/height/measured need to be right there.
 */

import type { ReactFlowInstance, InternalNode, Node } from "@xyflow/react";
import type { SchematicNode } from "../types";
import { computeDeviceHandles } from "./deviceHandleLayout";
import { STUB_W_EST, STUB_H_EST } from "../stubPlacement";

interface HandleBound {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const HANDLE_SIZE = 10;

function absPos(
  node: SchematicNode,
  map: Map<string, SchematicNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  while (parentId) {
    const parent = map.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function boundsForNode(node: SchematicNode): HandleBound[] {
  if (node.type === "device") {
    return computeDeviceHandles(node).map((h) => ({
      id: h.id,
      x: h.relX - HANDLE_SIZE / 2,
      y: h.relY - HANDLE_SIZE / 2,
      width: HANDLE_SIZE,
      height: HANDLE_SIZE,
    }));
  }
  if (node.type === "stub-label") {
    const w = node.measured?.width ?? STUB_W_EST;
    const h = node.measured?.height ?? STUB_H_EST;
    const cy = h / 2;
    return [
      { id: "l", x: -HANDLE_SIZE / 2, y: cy - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE },
      { id: "r", x: w - HANDLE_SIZE / 2, y: cy - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE },
    ];
  }
  return [];
}

/**
 * Build a ReactFlowInstance stand-in for the given nodes. Only getInternalNode is
 * implemented; everything else throws if accidentally used.
 */
export function createMockRfInstance(nodes: SchematicNode[]): ReactFlowInstance {
  const map = new Map<string, SchematicNode>();
  for (const n of nodes) map.set(n.id, n);

  const internal = new Map<string, InternalNode<Node>>();
  for (const n of nodes) {
    const pos = absPos(n, map);
    const source = boundsForNode(n);
    const measured =
      n.measured ??
      (n.type === "stub-label"
        ? { width: STUB_W_EST, height: STUB_H_EST }
        : { width: 144, height: 48 });
    internal.set(n.id, {
      id: n.id,
      type: n.type,
      measured,
      internals: {
        positionAbsolute: pos,
        handleBounds: { source, target: [] },
      },
    } as unknown as InternalNode<Node>);
  }

  return {
    getInternalNode: (id: string) => internal.get(id),
  } as unknown as ReactFlowInstance;
}
