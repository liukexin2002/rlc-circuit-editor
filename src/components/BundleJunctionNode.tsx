import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { BundleJunctionNode as BundleJunctionNodeType } from "../types";
import { useSchematicStore } from "../store";

/**
 * A bundle's draggable break-in / break-out point — the gather (role "in") and fan
 * (role "out") ends of the shared trunk. Pure POSITION ANCHOR: no edges attach, the
 * router reads its position as the comb's gather/fan point, and dragging it reroutes
 * the comb via the node digest.
 *
 * Like a waypoint, it stays invisible (and click-through) until the bundle is
 * highlighted — i.e. one of its member connections, or the handle itself, is selected.
 * Select a member to reveal the handles, then drag to reshape the trunk.
 */
function BundleJunctionNodeComponent({ data, selected }: NodeProps<BundleJunctionNodeType>) {
  const memberSelected = useSchematicStore((s) =>
    s.edges.some((e) => e.data?.bundleId === data.bundleId && e.selected),
  );
  const visible = selected || memberSelected;
  const size = selected ? 13 : 11;

  return (
    <div
      data-bundle-junction={data.role}
      title={`Bundle break-${data.role}`}
      style={{
        // Center the handle on the anchor point (the router's gather/fan point) so the
        // trunk meets the handle's center, not a corner.
        transform: "translate(-50%, -50%)",
        width: size,
        height: size,
        borderRadius: 3,
        background: visible ? (selected ? "#1a73e8" : "#475569") : "transparent",
        border: visible ? "2px solid white" : "none",
        boxShadow: visible
          ? selected
            ? "0 0 0 2px rgba(26,115,232,0.35)"
            : "0 0 0 1px rgba(0,0,0,0.35)"
          : "none",
        cursor: "grab",
        // Invisible handles don't intercept clicks meant for the canvas/edges underneath.
        pointerEvents: visible ? "all" : "none",
      }}
    />
  );
}

export default memo(BundleJunctionNodeComponent);
