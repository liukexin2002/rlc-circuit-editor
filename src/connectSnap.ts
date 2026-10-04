// One radius, one rule, for the whole connection drag (#366).
//
// A drag has two independent consumers deciding "which port is the cursor on":
// the ghost preview line the app draws itself, and React Flow's own drop handling
// (`connectionRadius` + the release in XYHandle). When they used separate copies of
// the number — and separate ways of picking the port — a drag could paint a coloured
// ghost at a distance where releasing did nothing, so the user had to creep closer
// before the connection took. Both now read CONNECT_SNAP_RADIUS and both resolve the
// target through resolveConnectTarget, so if the ghost snaps, the release lands.
//
// Re-routing an existing connection is React Flow's own gesture and keeps its own,
// narrower rule — resolveRelease says why, and the ghost follows the same rule there so
// it still can't promise more than the release will do.
//
// Kept free of store, React Flow and DOM imports so the decision is testable on its own.

/** Distance (in flow units, i.e. before zoom) at which a drag snaps to a port handle.
 *  Must be passed to React Flow as `connectionRadius` — that prop is the drop side of
 *  this same rule. */
export const CONNECT_SNAP_RADIUS = 30;

/** The parts of a node that decide whether a drag may land on its ports. */
export type ConnectableNodeShape = {
  id: string;
  type?: string;
  hidden?: boolean;
  /** Device data carries `offCanvas`; the other node kinds carry their own shapes. */
  data?: unknown;
};

/**
 * Can a drag land on this node's ports?
 *
 * Only devices carry ports, and only devices that are actually drawn can take a
 * connection. React Flow keeps the handle bounds and last position of a node it has
 * stopped rendering, so without this filter a search would find phantom ports: a
 * virtual patch panel leaves a full port column sitting in the empty patch of canvas it
 * used to occupy, and an auto-inserted adapter renders as a 1x1 invisible placeholder
 * mid-connection with all of its handles piled on one point. Neither can hold a
 * connection — the router drops both from its node set, and setPanelOffCanvas refuses to
 * make a wired panel virtual precisely because its connections would have nowhere to
 * land — so neither should attract the ghost or the release (#366).
 */
export function isConnectableDevice(
  node: ConnectableNodeShape,
  hiddenAdapterIds: ReadonlySet<string>,
): boolean {
  if (node.type !== "device") return false;
  const offCanvas = (node.data as { offCanvas?: unknown } | undefined)?.offCanvas;
  if (node.hidden || offCanvas) return false;
  return !hiddenAdapterIds.has(node.id);
}

/** A port handle the cursor could land on, positioned at its centre in flow space. */
export type SnapHandle = {
  nodeId: string;
  handleId: string;
  x: number;
  y: number;
};

/** The handle a drag started from — never a target for its own drag. */
export type SnapOrigin = { nodeId: string; handleId: string | null };

function isOrigin(nodeId: string, handleId: string, origin: SnapOrigin | undefined): boolean {
  return !!origin && origin.nodeId === nodeId && origin.handleId === handleId;
}

/**
 * Nearest handle whose centre is within `radius` of the pointer, or null.
 *
 * The bound is inclusive to match React Flow's own `getClosestHandle`, which skips a
 * handle only when `distance > connectionRadius`; an exclusive `<` here would put the
 * ghost one sub-pixel behind the drop on a dead-on hit at the rim.
 */
export function closestHandleWithinRadius(
  x: number,
  y: number,
  candidates: readonly SnapHandle[],
  origin?: SnapOrigin,
  radius: number = CONNECT_SNAP_RADIUS,
): SnapHandle | null {
  let best: SnapHandle | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (isOrigin(c.nodeId, c.handleId, origin)) continue;
    const dx = c.x - x;
    const dy = c.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= radius && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * The port a drag is on, given the pointer position and whichever handle is literally
 * under the cursor (null when the cursor is over the canvas, a device body, a label…).
 *
 * A handle under the cursor wins outright — React Flow does the same, because a port
 * you are pointing straight at should beat a neighbour whose centre happens to be a
 * pixel nearer. Everything else falls back to the radius search. Two cases deliberately
 * resolve to nothing rather than to a nearby port, because React Flow would refuse the
 * release there and the ghost must not promise otherwise: pointing at the drag's own
 * origin handle, and pointing at a handle that is not a connectable port at all (a stub
 * tag's, say, which never appears among the candidates).
 */
export function resolveConnectTarget(
  pointerX: number,
  pointerY: number,
  handleUnderCursor: { nodeId: string; handleId: string } | null,
  candidates: readonly SnapHandle[],
  origin?: SnapOrigin,
  radius: number = CONNECT_SNAP_RADIUS,
): SnapHandle | null {
  if (handleUnderCursor) {
    if (isOrigin(handleUnderCursor.nodeId, handleUnderCursor.handleId, origin)) return null;
    return (
      candidates.find(
        (c) => c.nodeId === handleUnderCursor.nodeId && c.handleId === handleUnderCursor.handleId,
      ) ?? null
    );
  }
  return closestHandleWithinRadius(pointerX, pointerY, candidates, origin, radius);
}

/** Everything the release backstop needs to know about how a drag ended. */
export type ReleaseGesture = {
  /** The handle the drag started from, or null when no drag is in flight. */
  origin: SnapOrigin | null;
  /** React Flow already made the connection itself — the backstop must stay out. */
  flowHandledConnect: boolean;
  /** This drag is re-routing an existing connection, not making a new one. */
  reconnecting: boolean;
  /** Pointer position at the release, in flow units. */
  pointerX: number;
  pointerY: number;
  handleUnderCursor: { nodeId: string; handleId: string } | null;
  candidates: readonly SnapHandle[];
  radius?: number;
};

/**
 * The port a release should act on, or null to leave the gesture alone.
 *
 * For a fresh connection drag this is simply "wherever the ghost snapped" — that is the
 * whole point of #366. A re-route is a different gesture, though: React Flow owns it
 * from end to end, re-wiring the connection through onReconnect or deleting it in
 * onReconnectEnd when the release found no port. It also fires the plain connect
 * callbacks along the way, and the connect end runs *before* the reconnect end, so a
 * backstop that acted on every release would double every successful re-route and turn
 * a deliberate disconnect over open canvas into a connection to whatever port happened
 * to be within the radius. So a re-route keeps the narrower rule: the cursor has to be
 * literally on a port, and the connection has to be one React Flow refused — which is
 * exactly the adapter case the backstop exists for.
 *
 * `isValidConnection` is consulted only for a target on the gesture's own device and on
 * the re-route path, so callers can build the connection lazily.
 */
export function resolveRelease(
  gesture: ReleaseGesture,
  isValidConnection: (target: SnapHandle) => boolean,
): SnapHandle | null {
  const { origin, flowHandledConnect, reconnecting, handleUnderCursor, candidates } = gesture;
  if (!origin || flowHandledConnect) return null;
  if (reconnecting && !handleUnderCursor) return null;
  const target = resolveConnectTarget(
    gesture.pointerX,
    gesture.pointerY,
    handleUnderCursor,
    candidates,
    origin,
    gesture.radius,
  );
  if (!target) return null;
  // A port on the gesture's own device. The store refuses nearly all of those, and
  // handing one to onConnect would offer an adapter between two ports of a single
  // device — so an invalid one stops here. It refuses them only *nearly* all, though:
  // a patch cable between two front jacks of one patch panel is a real connection the
  // store allows, and the ghost paints it green. React Flow makes that one itself on a
  // drag, but on the click path it only connects when the click is squarely on the
  // handle, so nothing stands behind this rule there — hence a valid same-device target
  // goes through rather than cancelling the gesture (#366).
  if (target.nodeId === origin.nodeId && !isValidConnection(target)) return null;
  if (reconnecting && isValidConnection(target)) return null;
  return target;
}

/** What the second click of a click-to-connect gesture should act on. */
export type ClickRelease =
  /** The port the ghost was snapped to — wire it exactly as a drag release would. */
  | { kind: "port"; target: SnapHandle }
  /** No port in range, but the click landed on a device body: fall back to picking a
   *  port on that device. */
  | { kind: "device"; nodeId: string }
  /** Nothing to act on — the gesture just ends. */
  | { kind: "cancel" };

/**
 * The click-to-connect twin of resolveRelease (#366).
 *
 * Click-to-connect ends on a click, and only a click landing squarely on a port reaches
 * React Flow's own handle click — everything else lands on the pane or on a device body,
 * where the app decides for itself. Those two used rules of their own: the pane cancelled
 * the gesture outright, and a device body scanned that whole device for "some port that
 * fits". So a click a few units short of a port did nothing while the ghost sat snapped
 * and coloured on it, which is Dylan's "if we see a ghost, a click should create the
 * connection".
 *
 * The snapped port therefore wins first, resolved through resolveRelease so the click and
 * the drag release cannot drift apart again — mismatches included, since those are the
 * ones React Flow refuses and only the app's own handler can turn into an adapter prompt.
 * The device-body fallback stays underneath it, for a click on a device with no port
 * within the radius.
 *
 * A click gesture is never a re-route — React Flow re-routes on drag only — so this pins
 * `reconnecting: false` rather than taking it from the caller. `isValidConnection` still
 * has to be real, though: resolveRelease asks it about a port on the gesture's own
 * device, and the one same-device connection the store allows (a patch cable across one
 * patch panel's front jacks) has no React Flow backstop behind it on the click path.
 */
export function resolveClickRelease(
  gesture: Omit<ReleaseGesture, "reconnecting">,
  isValidConnection: (target: SnapHandle) => boolean,
  clickedDeviceId: string | null,
): ClickRelease {
  const { origin, flowHandledConnect } = gesture;
  if (!origin || flowHandledConnect) return { kind: "cancel" };
  const target = resolveRelease({ ...gesture, reconnecting: false }, isValidConnection);
  if (target) return { kind: "port", target };
  // The gesture's own device is never the *fallback*, even so. The fallback scans a
  // whole device for a port that fits and hands the first misfit to onConnect if none
  // does, so on the device the gesture started from it would end up offering an adapter
  // between two ports of one device. A same-device connection that genuinely validates
  // has already been taken above, by the snapped-port branch.
  if (clickedDeviceId && clickedDeviceId !== origin.nodeId) {
    return { kind: "device", nodeId: clickedDeviceId };
  }
  return { kind: "cancel" };
}
