import type { ConnectionEdge, SchematicNode } from "./types";

/**
 * Discoverability cue for manual cable path editing (#275). Adding path handles
 * lives behind a right-click that users had no way to find, so a selected cable
 * shows a small hint pill pointing at the context menu. The hint only appears
 * when exactly one cable — and nothing else — is selected (any selected device
 * or multi-select is a bulk operation, not path editing) and disappears once
 * the cable carries any user-placed handle — at that point the user has found
 * the feature.
 */

/**
 * The id of the one selected cable when the selection is exactly one cable and
 * no devices (or other canvas items), else null. Memoized on the nodes/edges
 * array identities so every mounted edge shares a single scan per store commit
 * and pays only an O(1) id comparison itself.
 */
export function soleSelectedCableId(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
): string | null {
  if (nodes === cachedNodes && edges === cachedEdges) return cachedId;
  cachedNodes = nodes;
  cachedEdges = edges;
  cachedId = computeSoleSelectedCableId(nodes, edges);
  return cachedId;
}

let cachedNodes: SchematicNode[] | null = null;
let cachedEdges: ConnectionEdge[] | null = null;
let cachedId: string | null = null;

function computeSoleSelectedCableId(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
): string | null {
  // Any selected node means a bulk operation (e.g. a marquee that swept up
  // devices alongside the cable), not path editing.
  if (nodes.some((n) => n.selected)) return null;
  let sole: string | null = null;
  for (const e of edges) {
    if (!e.selected) continue;
    if (sole !== null) return null;
    sole = e.id;
  }
  return sole;
}

export function showPathEditHint(opts: {
  /** This cable is selected AND it is the only selected item on the canvas. */
  soleSelected: boolean;
  /** A routed path exists to anchor the hint to. */
  hasRoute: boolean;
  /** The cable already has user-placed handles (manual or stub-leg waypoints). */
  hasOwnWaypoints: boolean;
  /** Direct-attach edges represent a physical plug-in — no cable run to shape. */
  directAttach: boolean;
}): boolean {
  return opts.soleSelected && opts.hasRoute && !opts.hasOwnWaypoints && !opts.directAttach;
}
