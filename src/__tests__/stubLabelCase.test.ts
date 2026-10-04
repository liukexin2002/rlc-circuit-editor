// Auto-case (#294) coverage for wire-label stubs. The stub's text is assembled from four
// resolved parts — device name, far-end port, room, page — and the display-case preference
// has to reach every label-ish one of them while leaving the arrow and the "Pg" tag alone.
//
// The device name and the room are transformed at render time in StubLabelNode.tsx; the
// far-end port is transformed further upstream, inside resolvePortLabel. These tests pin
// both halves so neither can regress independently.

import { describe, it, expect, afterEach } from "vitest";
import { buildStubLabelText, type StubLabelParts } from "../stubLabelText";
import { transformLabel } from "../labelCaseUtils";
import { resolvePortLabel } from "../packList";
import { useSchematicStore } from "../store";
import { DEFAULT_STUB_LABEL_SHOW_ARROW } from "../types";
import type { LabelCaseMode, SchematicNode } from "../types";

const farDevice = {
  id: "d1",
  type: "device",
  position: { x: 0, y: 0 },
  data: {
    label: "Projector",
    ports: [{ id: "p1", label: "HDMI In 1", signalType: "hdmi", direction: "input" }],
  },
} as unknown as SchematicNode;

/** Mirror of the assembly StubLabelNode.tsx performs, with the same parts transformed.
 *  Most cases here run with the arrow forced on so the "never touches the arrow" case
 *  has an arrow to guard; showArrow lets one case run at the shipping default (#350). */
const stubText = (mode: LabelCaseMode, over: Partial<StubLabelParts> = {}, showArrow = true) => {
  const d = (t: string) => transformLabel(t, mode);
  const parts: StubLabelParts = {
    arrow: "→",
    farLabel: "Projector",
    farPort: resolvePortLabel(farDevice, "p1"),
    farRoom: "Main Hall",
    myPage: "1",
    farPage: "3",
    cableId: "HDMI-001",
    ...over,
  };
  return buildStubLabelText(
    { ...parts, farLabel: d(parts.farLabel), farRoom: d(parts.farRoom) },
    { showArrow, showPort: true, showRoom: true, pageMode: "always" },
  );
};

afterEach(() => {
  useSchematicStore.setState({ labelCase: "as-typed" });
});

describe("stub-label auto-case (#294)", () => {
  it("leaves every part as-typed under the default preference", () => {
    useSchematicStore.setState({ labelCase: "as-typed" });
    expect(stubText("as-typed")).toBe("→ Projector [HDMI In 1] (Main Hall) Pg 3");
  });

  it("uppercases the device name, the far-end port, and the room together", () => {
    useSchematicStore.setState({ labelCase: "uppercase" });
    expect(stubText("uppercase")).toBe("→ PROJECTOR [HDMI IN 1] (MAIN HALL) Pg 3");
  });

  it("lowercases all three the same way", () => {
    useSchematicStore.setState({ labelCase: "lowercase" });
    expect(stubText("lowercase")).toBe("→ projector [hdmi in 1] (main hall) Pg 3");
  });

  it("capitalizes all three the same way", () => {
    useSchematicStore.setState({ labelCase: "capitalize" });
    expect(stubText("capitalize", { farLabel: "front projector", farRoom: "main hall" }))
      .toBe("→ Front Projector [HDMI In 1] (Main Hall) Pg 3");
  });

  it("never touches the arrow or the page tag", () => {
    useSchematicStore.setState({ labelCase: "lowercase" });
    // "Pg" would become "pg" and the arrow would be at risk if the transform were applied
    // to the assembled string instead of the individual parts.
    const t = stubText("lowercase", { arrow: "←" });
    expect(t.startsWith("← ")).toBe(true);
    expect(t.endsWith(" Pg 3")).toBe(true);
  });

  it("transforms the same parts at the shipping arrow default (#350)", () => {
    useSchematicStore.setState({ labelCase: "uppercase" });
    expect(stubText("uppercase", {}, DEFAULT_STUB_LABEL_SHOW_ARROW))
      .toBe("PROJECTOR [HDMI IN 1] (MAIN HALL) Pg 3");
  });

  // A cable ID is an identifier printed on a physical label, not a device name — Title
  // Case turning "HDMI-001" into "Hdmi-001" would put the wrong text on the cable. Both
  // composers deliberately pass it through untransformed; this pins that they keep doing
  // so, since "apply the transform to every part" is an easy refactor to talk yourself
  // into (#270).
  it("never transforms the cable ID of a cable-ID-only tag", () => {
    for (const mode of ["as-typed", "uppercase", "lowercase", "capitalize"] as LabelCaseMode[]) {
      useSchematicStore.setState({ labelCase: mode });
      const d = (t: string) => transformLabel(t, mode);
      const text = buildStubLabelText(
        {
          arrow: "→", farLabel: d("Projector"), farPort: resolvePortLabel(farDevice, "p1"),
          farRoom: d("Main Hall"), myPage: "1", farPage: "3", cableId: "HDMI-001",
        },
        { showArrow: true, showPort: true, showRoom: true, pageMode: "always", labelMode: "cableId" },
      );
      expect(text).toBe("HDMI-001");
    }
  });

  it("resolvePortLabel is where the far-end port picks up the case preference", () => {
    useSchematicStore.setState({ labelCase: "as-typed" });
    expect(resolvePortLabel(farDevice, "p1")).toBe("HDMI In 1");
    useSchematicStore.setState({ labelCase: "uppercase" });
    expect(resolvePortLabel(farDevice, "p1")).toBe("HDMI IN 1");
  });
});
