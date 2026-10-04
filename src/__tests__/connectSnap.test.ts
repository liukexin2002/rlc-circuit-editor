/**
 * Connection drag: the ghost preview and the release resolve the same port (#366).
 *
 * Dylan's report: a drag could paint the coloured ghost onto a port and then do nothing
 * on release unless the cursor crept closer. The two sides had drifted apart — the ghost
 * snapped anywhere inside a 30-unit radius, but the release path resolved its port with
 * document.elementFromPoint, i.e. only when the cursor sat literally on the ~10-unit
 * handle. connectSnap holds the one radius and the one decision both now call, so these
 * cases pin the rule rather than either caller's copy of it.
 *
 * Geometry below is a stripped port column at the real 16-px row pitch, with the seeded
 * fixture's handle ids (bidirectional ports own "<port>-in"/"<port>-out", and several
 * plain port ids end in those same tokens).
 */
import { describe, it, expect, vi } from "vitest";
import {
  CONNECT_SNAP_RADIUS,
  closestHandleWithinRadius,
  isConnectableDevice,
  resolveClickRelease,
  resolveConnectTarget,
  resolveRelease,
  type ReleaseGesture,
  type SnapHandle,
} from "../connectSnap";

/** Projector's left-hand input column: two ports, one row apart. */
const PROJECTOR: SnapHandle[] = [
  { nodeId: "device-proj", handleId: "proj-hdmi-in", x: 400, y: 200 },
  { nodeId: "device-proj", handleId: "proj-sdi-in", x: 400, y: 216 },
];

/** Switcher's right-hand column, well clear of the projector. A bidirectional port
 *  contributes both faces; "hub-usb-in" is a plain port whose id merely ends in -in. */
const SWITCHER: SnapHandle[] = [
  { nodeId: "device-sw", handleId: "sw-net-1-in", x: 100, y: 200 },
  { nodeId: "device-sw", handleId: "sw-net-1-out", x: 180, y: 200 },
  { nodeId: "device-sw", handleId: "hub-usb-in", x: 100, y: 216 },
];

/** A patch panel's front face: two jacks of one device, the one same-device pairing
 *  validateConnection allows (a patch cable between two front jacks, store.ts). */
const PANEL: SnapHandle[] = [
  { nodeId: "device-panel", handleId: "jack-1-front", x: 600, y: 200 },
  { nodeId: "device-panel", handleId: "jack-5-front", x: 600, y: 264 },
];

const ALL = [...PROJECTOR, ...SWITCHER];
const ORIGIN = { nodeId: "device-laptop", handleId: "laptop-hdmi-out" };

describe("isConnectableDevice", () => {
  const NONE: ReadonlySet<string> = new Set();

  it("accepts a device that is on canvas", () => {
    expect(isConnectableDevice({ id: "device-proj", type: "device" }, NONE)).toBe(true);
  });

  it("skips everything that isn't a device", () => {
    expect(isConnectableDevice({ id: "stub-label-3", type: "stubLabel" }, NONE)).toBe(false);
    expect(isConnectableDevice({ id: "room-1", type: "room" }, NONE)).toBe(false);
  });

  it("skips a virtual patch panel, whose ports are no longer drawn", () => {
    // setPanelOffCanvas hides the panel but React Flow keeps its handle bounds at the
    // position it last occupied — connecting there would wire a device nobody can see.
    const panel = { id: "device-pp1", type: "device", hidden: true, data: { offCanvas: true } };
    expect(isConnectableDevice(panel, NONE)).toBe(false);
  });

  it("skips an auto-inserted adapter that renders as an invisible placeholder", () => {
    const adapter = { id: "device-adapter-7", type: "device" };
    expect(isConnectableDevice(adapter, new Set(["device-adapter-7"]))).toBe(false);
  });
});

describe("closestHandleWithinRadius", () => {
  it("finds a port anywhere inside the snap radius, not just under the cursor", () => {
    // 25 units out — the ghost snapped here already; the release must agree.
    const hit = closestHandleWithinRadius(400 - 25, 200, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-hdmi-in");
  });

  it("returns nothing past the radius", () => {
    const hit = closestHandleWithinRadius(400 - (CONNECT_SNAP_RADIUS + 1), 200, ALL, ORIGIN);
    expect(hit).toBeNull();
  });

  it("includes the rim, matching React Flow's own inclusive bound", () => {
    const hit = closestHandleWithinRadius(400 - CONNECT_SNAP_RADIUS, 200, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-hdmi-in");
  });

  it("picks the nearer of two ports one row apart", () => {
    // Row pitch is 16, so a cursor at y=214 is inside the radius of both.
    const hit = closestHandleWithinRadius(400, 214, PROJECTOR, ORIGIN);
    expect(hit?.handleId).toBe("proj-sdi-in");
  });

  it("never snaps a drag back onto the handle it started from", () => {
    const withOrigin = [...ALL, { nodeId: "device-laptop", handleId: "laptop-hdmi-out", x: 300, y: 300 }];
    const hit = closestHandleWithinRadius(300, 300, withOrigin, ORIGIN);
    expect(hit).toBeNull();
  });

  it("distinguishes the two faces of a bidirectional port", () => {
    expect(closestHandleWithinRadius(105, 200, SWITCHER, ORIGIN)?.handleId).toBe("sw-net-1-in");
    expect(closestHandleWithinRadius(175, 200, SWITCHER, ORIGIN)?.handleId).toBe("sw-net-1-out");
  });
});

describe("resolveConnectTarget", () => {
  it("prefers the port under the cursor over a marginally nearer neighbour", () => {
    // Cursor sits on the SDI row but a hair closer to the HDMI centre.
    const hit = resolveConnectTarget(400, 207, { nodeId: "device-proj", handleId: "proj-sdi-in" }, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-sdi-in");
  });

  it("falls back to the radius search when the cursor is over open canvas", () => {
    const hit = resolveConnectTarget(400 - 22, 200, null, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-hdmi-in");
  });

  it("resolves to nothing while the cursor is over the drag's own origin handle", () => {
    // React Flow refuses that release, so the ghost must not offer a neighbour instead.
    const withOrigin = [...PROJECTOR, { nodeId: "device-laptop", handleId: "laptop-hdmi-out", x: 400, y: 190 }];
    const hit = resolveConnectTarget(400, 190, ORIGIN, withOrigin, ORIGIN);
    expect(hit).toBeNull();
  });

  it("resolves to nothing over a handle that is not a connectable port", () => {
    // Stub tag handles never reach the candidate list; releasing on one does nothing,
    // and a green ghost pointing at a nearby port would be a lie.
    const hit = resolveConnectTarget(400, 205, { nodeId: "stub-label-3", handleId: "tag" }, ALL, ORIGIN);
    expect(hit).toBeNull();
  });

  it("returns the candidate's own centre so the ghost lands on the port it will use", () => {
    const hit = resolveConnectTarget(410, 210, null, ALL, ORIGIN);
    expect(hit).toEqual({ nodeId: "device-proj", handleId: "proj-sdi-in", x: 400, y: 216 });
  });
});

describe("resolveRelease", () => {
  /** A drag from the laptop's HDMI output, released 22 units short of the projector's
   *  HDMI input — the ghost is snapped and coloured there. */
  const gesture = (over: Partial<ReleaseGesture> = {}): ReleaseGesture => ({
    origin: ORIGIN,
    flowHandledConnect: false,
    reconnecting: false,
    pointerX: 400 - 22,
    pointerY: 200,
    handleUnderCursor: null,
    candidates: ALL,
    ...over,
  });

  const valid = () => true;
  const invalid = () => false;

  it("acts on the port the ghost snapped to, even over open canvas", () => {
    // The whole of #366: coloured ghost at 22 units, so the release must land there.
    expect(resolveRelease(gesture(), invalid)?.handleId).toBe("proj-hdmi-in");
  });

  it("stands down once React Flow has made the connection itself", () => {
    expect(resolveRelease(gesture({ flowHandledConnect: true }), invalid)).toBeNull();
  });

  it("stands down with no drag in flight", () => {
    expect(resolveRelease(gesture({ origin: null }), invalid)).toBeNull();
  });

  it("leaves a port on the drag's own device alone when the store would refuse it", () => {
    const sameDevice = gesture({
      origin: { nodeId: "device-proj", handleId: "proj-hdmi-in" },
      pointerX: 400,
      pointerY: 216,
      handleUnderCursor: { nodeId: "device-proj", handleId: "proj-sdi-in" },
    });
    expect(resolveRelease(sameDevice, invalid)).toBeNull();
  });

  it("takes a port on the drag's own device when the store allows it — the patch cable", () => {
    // Two front jacks of one patch panel: validateConnection permits exactly this pairing,
    // and the ghost paints it green, so the release must not throw the gesture away.
    const patchCable = gesture({
      origin: { nodeId: "device-panel", handleId: "jack-1-front" },
      pointerX: PANEL[1].x,
      pointerY: PANEL[1].y,
      candidates: PANEL,
    });
    expect(resolveRelease(patchCable, valid)?.handleId).toBe("jack-5-front");
  });

  it("asks about validity only for a port on the drag's own device", () => {
    const isValid = vi.fn(() => false);
    resolveRelease(gesture(), isValid);
    expect(isValid).not.toHaveBeenCalled();
  });

  describe("re-routing an existing connection", () => {
    /** Dragging a connection's device end off "proj-hdmi-in" and onto a sibling port.
     *  React Flow fires the connect callbacks for this drag too, and the connect end
     *  runs before the reconnect end. */
    const reroute = (over: Partial<ReleaseGesture> = {}) =>
      gesture({ reconnecting: true, ...over });

    it("stays out of a re-route React Flow accepted, instead of duplicating it", () => {
      // Dropped straight on the switcher's input, a connection React Flow will make.
      // Acting here too would leave two identical connections and two undo steps.
      const dropped = reroute({
        pointerX: 100,
        pointerY: 200,
        handleUnderCursor: { nodeId: "device-sw", handleId: "sw-net-1-in" },
      });
      expect(resolveRelease(dropped, valid)).toBeNull();
    });

    it("invents nothing when the release lands on open canvas — that gesture disconnects", () => {
      // 22 units from the projector's input but on no handle at all: React Flow deletes
      // the connection in onReconnectEnd, and a new connection here would cost a second
      // undo to unpick one gesture.
      expect(resolveRelease(reroute(), invalid)).toBeNull();
      expect(resolveRelease(reroute(), valid)).toBeNull();
    });

    it("still raises the adapter prompt for a re-route onto a mismatched port", () => {
      const dropped = reroute({
        pointerX: 100,
        pointerY: 216,
        handleUnderCursor: { nodeId: "device-sw", handleId: "hub-usb-in" },
      });
      expect(resolveRelease(dropped, invalid)?.handleId).toBe("hub-usb-in");
    });
  });
});

/**
 * Click-to-connect's second click (#366 rework).
 *
 * Dylan's follow-up: "Works correctly with dragging. It doesn't work with clicking. If I
 * click to start a ghost than move towards the port, I get a ghost connection, but if I
 * click it doesn't connect unless I'm right on top of the connection. If we see a ghost,
 * a click should create the connection."
 *
 * Only a click landing squarely on a port reaches React Flow's own handle click; anything
 * else lands on the pane or a device body, where the app decided for itself — the pane
 * cancelled, and a device body scanned that whole device. These pin the one rule both now
 * follow.
 *
 * The third landing spot, an existing cable, has no decision to pin here: a cable's
 * interaction stroke reached neither handler, so the fix is the `click-connecting` class
 * in index.css, which takes the cable layer out of the way for the length of the gesture
 * and routes that click to the pane. Only the manual gate covers it.
 */
describe("resolveClickRelease", () => {
  /** Clicked out of the laptop's HDMI output, second click 22 units short of the
   *  projector's HDMI input — the ghost is snapped and coloured on it. */
  const click = (over: Partial<Omit<ReleaseGesture, "reconnecting">> = {}) => ({
    origin: ORIGIN,
    flowHandledConnect: false,
    pointerX: 400 - 22,
    pointerY: 200,
    handleUnderCursor: null,
    candidates: ALL,
    ...over,
  });

  const valid = () => true;
  const invalid = () => false;

  /** Clicked out of a patch panel's front jack 1, second click 22 units short of front
   *  jack 5 on the same panel. */
  const samePanel = (over: Partial<Omit<ReleaseGesture, "reconnecting">> = {}) =>
    click({
      origin: { nodeId: "device-panel", handleId: "jack-1-front" },
      pointerX: PANEL[1].x,
      pointerY: PANEL[1].y - 22,
      candidates: PANEL,
      ...over,
    });

  it("wires the port the ghost snapped to, though the click landed on open canvas", () => {
    // The whole of the rework: this click used to hit onPaneClick and cancel outright.
    const decision = resolveClickRelease(click(), invalid, null);
    expect(decision).toEqual({ kind: "port", target: PROJECTOR[0] });
  });

  it("takes the snapped port for a mismatch too, so the adapter prompt still opens", () => {
    // A mismatch on another device doesn't consult validity at all — the store raises
    // the mismatch in onConnect, exactly as it does for a drag release.
    const decision = resolveClickRelease(
      click({ pointerX: 100 - 22, pointerY: 216 }),
      invalid,
      null,
    );
    expect(decision).toEqual({ kind: "port", target: SWITCHER[2] });
  });

  it("prefers the port under the cursor over a marginally nearer neighbour", () => {
    const decision = resolveClickRelease(
      click({
        pointerX: 400,
        pointerY: 204,
        handleUnderCursor: { nodeId: "device-proj", handleId: "proj-sdi-in" },
      }),
      invalid,
      "device-proj",
    );
    expect(decision).toEqual({ kind: "port", target: PROJECTOR[1] });
  });

  it("cancels a click on open canvas with no port in range", () => {
    expect(resolveClickRelease(click({ pointerX: 400 - 40 }), invalid, null)).toEqual({
      kind: "cancel",
    });
  });

  it("cancels when no click-to-connect gesture is in flight", () => {
    expect(resolveClickRelease(click({ origin: null }), invalid, "device-proj")).toEqual({
      kind: "cancel",
    });
  });

  it("stands down once React Flow has made the connection itself", () => {
    // Both branches: neither the snapped port nor the device fallback may re-run it.
    expect(resolveClickRelease(click({ flowHandledConnect: true }), invalid, null)).toEqual({
      kind: "cancel",
    });
    expect(resolveClickRelease(click({ flowHandledConnect: true }), invalid, "device-proj")).toEqual({
      kind: "cancel",
    });
  });

  describe("a second port on the gesture's own device", () => {
    it("wires the patch cable the store allows, instead of cancelling the gesture", () => {
      // The one same-device pairing validateConnection permits. React Flow makes it
      // itself on a drag; on the click path it only connects when the click is squarely
      // on the handle, so cancelling here left a green ghost that did nothing.
      expect(resolveClickRelease(samePanel(), valid, "device-panel")).toEqual({
        kind: "port",
        target: PANEL[1],
      });
    });

    it("still cancels the same-device pairings the store refuses", () => {
      // Two ports of one ordinary device: handing this to onConnect would offer an
      // adapter between two ports of a single device.
      const sibling = click({
        origin: { nodeId: "device-proj", handleId: "proj-hdmi-in" },
        pointerX: 400,
        pointerY: 216 - 4,
        candidates: PROJECTOR,
      });
      expect(resolveClickRelease(sibling, invalid, "device-proj")).toEqual({ kind: "cancel" });
    });
  });

  describe("the device-body fallback underneath the snap", () => {
    it("falls back to the clicked device when no port is within the radius", () => {
      const decision = resolveClickRelease(click({ pointerX: 400 - 40 }), invalid, "device-proj");
      expect(decision).toEqual({ kind: "device", nodeId: "device-proj" });
    });

    it("never overrides a snapped port, even on a different device", () => {
      // Clicking the switcher's body with the ghost snapped to the projector's input
      // takes the projector's input — the ghost is what the user was aiming at.
      const decision = resolveClickRelease(click(), invalid, "device-sw");
      expect(decision).toEqual({ kind: "port", target: PROJECTOR[0] });
    });

    it("never scans the gesture's own device, even one whose ports could pair", () => {
      // The body of the panel the gesture started from, with no port in range. The scan
      // hands the first misfit port to onConnect when none fits, which on this device
      // means offering an adapter between two of its own ports — so it stays out. A
      // same-device pairing that genuinely validates is taken by the snap above instead.
      const ownDevice = samePanel({ pointerX: PANEL[1].x, pointerY: PANEL[1].y - 40 });
      expect(resolveClickRelease(ownDevice, valid, "device-panel")).toEqual({ kind: "cancel" });
    });
  });
});
