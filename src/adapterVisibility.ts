import type { ConnectionEdge, DeviceData, SchematicNode } from "./types";

/**
 * Whether an adapter reads as hidden given its own visibility override and the
 * global "hide adapters" toggle. 'default' defers to the global toggle; an
 * explicit force-hide/force-show always wins. Shared by DeviceContextMenu and
 * EdgeContextMenu so the two Hide/Show Adapter menu items can't drift (#312).
 */
export function isAdapterHidden(
  visibility: DeviceData["adapterVisibility"] | undefined,
  globalHideAdapters: boolean,
): boolean {
  const current = visibility ?? "default";
  return current === "force-hide" || (current === "default" && globalHideAdapters);
}

/** Flip an adapter's visibility override, reading 'default' per {@link isAdapterHidden}. */
export function toggleAdapterVisibility(
  visibility: DeviceData["adapterVisibility"] | undefined,
  globalHideAdapters: boolean,
): "force-show" | "force-hide" {
  return isAdapterHidden(visibility, globalHideAdapters) ? "force-show" : "force-hide";
}

/**
 * The inline adapters the canvas is hiding right now: every adapter device whose
 * per-device override says `force-hide`, plus — when the global "hide adapters" toggle
 * is on — every adapter that has not opted out with `force-show`.
 *
 * recomputeRoutes derives this to splice a hidden adapter's two connections into one
 * that draws straight through. Everything that has to read the schematic the way the
 * user sees it — the stub tag's pairing host and the device its label names (#334,
 * #348) — resolves against the same set, so one rule decides what "hidden" means.
 */
export function resolveHiddenAdapterIds(
  nodes: readonly SchematicNode[],
  hideAdapters: boolean,
): Set<string> {
  const hidden = new Set<string>();
  for (const n of nodes) {
    if (n.type !== "device") continue;
    const data = n.data as DeviceData;
    if (data.deviceType !== "adapter") continue;
    if (data.adapterVisibility === "force-show") continue;
    if (data.adapterVisibility === "force-hide" || hideAdapters) hidden.add(n.id);
  }
  return hidden;
}

/** Where a connection lands: the device it arrives at and the port on it. */
export interface RunEnd {
  nodeId: string;
  handleId: string | null;
}

/**
 * Follow a run past any hidden inline adapters it arrives at, and report the visible
 * device — and the port on it — the run really terminates at.
 *
 * `arrivedAt` is where the connection `arrivedVia` ended; when that device is a hidden
 * adapter the walk continues out of its other side, repeating for a chain of them. A
 * hidden adapter renders as a 1x1 pointerEvents:none placeholder that no selection can
 * contain, and recomputeRoutes splices its two connections into one that draws straight
 * through, so the device on the far side is what the user actually sees and reads.
 * Shared by the tag-pairing walk and the stub tag's own label so the two can't drift
 * (#334, #348). A visible adapter is a real device and stops the walk.
 *
 * Only a connection onward to another DEVICE counts. An adapter whose far side is
 * itself stubbed has legs running to stub-label tags, and those name nothing a reader
 * could follow, so the walk stops on the adapter exactly as it does when nothing is
 * plugged into its far side at all.
 */
export function hopHiddenAdapters(
  arrivedAt: RunEnd,
  arrivedVia: string | undefined,
  nodes: readonly SchematicNode[],
  edges: readonly ConnectionEdge[],
  hiddenAdapterIds?: ReadonlySet<string>,
): RunEnd {
  if (!hiddenAdapterIds?.has(arrivedAt.nodeId)) return arrivedAt;
  const deviceIds = new Set(nodes.filter((n) => n.type === "device").map((n) => n.id));
  let end = arrivedAt;
  let legId = arrivedVia;
  const seen = new Set<string>();
  while (hiddenAdapterIds.has(end.nodeId) && !seen.has(end.nodeId)) {
    seen.add(end.nodeId);
    const from = end.nodeId;
    const onward = edges.find((e) => {
      if (e.id === legId || (e.source !== from && e.target !== from)) return false;
      return deviceIds.has(e.source === from ? e.target : e.source);
    });
    if (!onward) break;
    legId = onward.id;
    const outbound = onward.source === from;
    end = {
      nodeId: outbound ? onward.target : onward.source,
      handleId: (outbound ? onward.targetHandle : onward.sourceHandle) ?? null,
    };
  }
  return end;
}
