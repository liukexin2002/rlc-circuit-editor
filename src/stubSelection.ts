/**
 * What a bulk connection action should treat as selected (#349).
 *
 * A stubbed connection is drawn as two short legs plus the two tags at their open ends,
 * and the tag is the only part of it with real hit area — a marquee over a column of
 * stubs, or the selection bar's "keep only stubs" filter, leaves the tag nodes selected
 * and no connections at all. Reading `edge.selected` alone therefore reports a
 * stubs-only selection as zero connections, and every bulk surface disappears.
 *
 * So a stubbed connection counts as selected when EITHER of its legs is selected OR
 * EITHER of its tags is; both legs come along, since the pair is one logical cable.
 */
import type { ConnectionEdge, SchematicNode, StubLabelData } from "./types";

/** The selected connections, with the legs of every stubbed connection whose tag is selected. */
export function selectedConnectionEdges(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
): ConnectionEdge[] {
  const taggedLinkIds = new Set<string>();
  for (const n of nodes) {
    if (!n.selected || n.type !== "stub-label") continue;
    const linkedId = (n.data as StubLabelData | undefined)?.linkedConnectionId;
    if (linkedId) taggedLinkIds.add(linkedId);
  }
  if (taggedLinkIds.size === 0) return edges.filter((e) => e.selected);
  return edges.filter(
    (e) => e.selected || (e.data?.linkedConnectionId && taggedLinkIds.has(e.data.linkedConnectionId)),
  );
}

/** One id per stubbed connection in the given set — two legs of one cable count once. */
export function stubbedLinkIdsOf(edges: ConnectionEdge[]): string[] {
  return [...new Set(edges.map((e) => e.data?.linkedConnectionId).filter(Boolean) as string[])];
}
