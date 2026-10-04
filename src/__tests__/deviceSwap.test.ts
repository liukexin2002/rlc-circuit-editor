import { describe, it, expect } from "vitest";
import {
  planDeviceSwap,
  applyManualMapping,
  toggleAutoInstalledCard,
  summarizePlan,
} from "../deviceSwap";
import type { ConnectionEdge, DeviceData, DeviceTemplate, Port } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function port(
  id: string,
  label: string,
  signalType: string,
  direction: "input" | "output" | "bidirectional" | "passthrough" = "input",
  extras: Partial<Port> = {},
): Port {
  return {
    id,
    label,
    signalType: signalType as Port["signalType"],
    direction,
    ...extras,
  };
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): ConnectionEdge {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    data: { signalType: "sdi" },
  } as ConnectionEdge;
}

function deviceData(label: string, ports: Port[], templateId?: string): DeviceData {
  return {
    label,
    deviceType: "test",
    ports,
    ...(templateId ? { templateId } : {}),
  };
}

function template(label: string, ports: Port[], id?: string, slots?: DeviceTemplate["slots"]): DeviceTemplate {
  return {
    deviceType: "test",
    label,
    ports,
    ...(id ? { id } : {}),
    ...(slots ? { slots } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Same-template swap (round-trip)
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — same-template swap", () => {
  it("matches all ports by templatePortId when device shares template lineage", () => {
    const oldPorts: Port[] = [
      port("p-old-1", "IN 1", "sdi", "input", { templatePortId: "t-1" }),
      port("p-old-2", "OUT 1", "sdi", "output", { templatePortId: "t-2" }),
    ];
    const oldDev = deviceData("Source", oldPorts);
    const edges: ConnectionEdge[] = [
      edge("e1", "other-1", "p-other", "device-1", "p-old-1"),
      edge("e2", "device-1", "p-old-2", "other-2", "p-other"),
    ];
    const newTpl = template("Source v2", [
      port("t-1", "IN 1", "sdi", "input"),
      port("t-2", "OUT 1", "sdi", "output"),
    ]);
    const plan = planDeviceSwap(oldDev, "device-1", newTpl, edges);

    expect(plan.mappings).toHaveLength(2);
    expect(plan.mappings.every((m) => m.matchSource === "templatePortId")).toBe(true);
    expect(plan.mappings.every((m) => m.newPortRef !== null)).toBe(true);
    expect(summarizePlan(plan)).toEqual({ remapped: 2, dropped: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-template, label-aligned (Kumo 3232 → 6464 scenario)
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — cross-template label alignment", () => {
  it("Kumo 3232 → Kumo 6464: all connections map to the first N ports of the bigger device", () => {
    // Old device: 4 SDI inputs + 4 SDI outputs (synth 'Kumo 3232').
    const oldPorts: Port[] = [];
    for (let i = 1; i <= 4; i++) oldPorts.push(port(`p-in-${i}`, `INPUT ${i}`, "sdi", "input"));
    for (let i = 1; i <= 4; i++) oldPorts.push(port(`p-out-${i}`, `OUTPUT ${i}`, "sdi", "output"));
    const oldDev = deviceData("Kumo 3232", oldPorts);

    // Edges hit every port.
    const edges: ConnectionEdge[] = [];
    for (let i = 1; i <= 4; i++) {
      edges.push(edge(`ei${i}`, "src", "ps", "dev", `p-in-${i}`));
      edges.push(edge(`eo${i}`, "dev", `p-out-${i}`, "tgt", "pt"));
    }

    // New template: 8 SDI in + 8 SDI out (synth 'Kumo 6464'), fresh port IDs and no shared templatePortIds.
    const newPorts: Port[] = [];
    for (let i = 1; i <= 8; i++) newPorts.push(port(`new-in-${i}`, `INPUT ${i}`, "sdi", "input"));
    for (let i = 1; i <= 8; i++) newPorts.push(port(`new-out-${i}`, `OUTPUT ${i}`, "sdi", "output"));
    const newTpl = template("Kumo 6464", newPorts);

    const plan = planDeviceSwap(oldDev, "dev", newTpl, edges);

    expect(plan.mappings).toHaveLength(8);
    expect(plan.mappings.every((m) => m.matchSource === "label")).toBe(true);
    expect(plan.mappings.every((m) => m.newPortRef !== null)).toBe(true);
    expect(summarizePlan(plan)).toEqual({ remapped: 8, dropped: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Smaller target — extras get dropped
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — capacity downgrade", () => {
  it("drops connections that exceed the new device's port count", () => {
    const oldPorts = [
      port("p-1", "IN 1", "sdi", "input"),
      port("p-2", "IN 2", "sdi", "input"),
      port("p-3", "IN 3", "sdi", "input"),
    ];
    const oldDev = deviceData("Big", oldPorts);
    const edges = [
      edge("e1", "x", "px", "dev", "p-1"),
      edge("e2", "x", "px", "dev", "p-2"),
      edge("e3", "x", "px", "dev", "p-3"),
    ];
    const newTpl = template("Small", [
      port("n-1", "IN 1", "sdi", "input"),
      port("n-2", "IN 2", "sdi", "input"),
    ]);
    const plan = planDeviceSwap(oldDev, "dev", newTpl, edges);

    const sum = summarizePlan(plan);
    expect(sum.remapped).toBe(2);
    expect(sum.dropped).toBe(1);
    // The drop should be the one that couldn't find a label match.
    const dropped = plan.mappings.find((m) => m.newPortRef === null);
    expect(dropped?.oldPort.label).toBe("IN 3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Direction conflict is never auto-suggested
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — direction safety", () => {
  it("never auto-maps across mismatched directions", () => {
    const oldDev = deviceData("Outputs only", [port("p-1", "OUT 1", "sdi", "output")]);
    const edges = [edge("e1", "dev", "p-1", "x", "px")];
    // Only input ports on new template — no auto-match should occur.
    const newTpl = template("Inputs only", [port("n-1", "OUT 1", "sdi", "input")]);
    const plan = planDeviceSwap(oldDev, "dev", newTpl, edges);

    expect(plan.mappings).toHaveLength(1);
    expect(plan.mappings[0].newPortRef).toBeNull();
    expect(plan.mappings[0].matchSource).toBe("none");
  });

  it("flags directionMismatch when a user manually picks a cross-direction port", () => {
    const oldDev = deviceData("Outputs only", [port("p-1", "OUT 1", "sdi", "output")]);
    const edges = [edge("e1", "dev", "p-1", "x", "px")];
    const newTpl = template("Mixed", [
      port("n-1", "IN 1", "sdi", "input"),
      port("n-2", "OUT 1", "sdi", "output"),
    ]);
    let plan = planDeviceSwap(oldDev, "dev", newTpl, edges);
    // Auto picks the output by label.
    expect(plan.mappings[0].newPortRef).not.toBeNull();
    // Manually pick the wrong-direction one.
    const inputPort = plan.newPortPool.find((p) => p.direction === "input")!;
    plan = applyManualMapping(plan, plan.mappings[0].oldHandle, "source", inputPort.id);
    expect(plan.mappings[0].conflict?.kind).toBe("directionMismatch");
    expect(plan.mappings[0].matchSource).toBe("manual");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stub-edge identification (planner does NOT cascade-drop — that's the store's job)
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — stub-leg edges", () => {
  it("collects stub-leg edges per linkedConnectionId for the store to cascade", () => {
    const oldDev = deviceData("Src", [port("p-1", "OUT 1", "sdi", "output")]);
    // A stubbed connection: device → stub-label node (one leg). The other leg
    // (stub → real target) lives in the edges array too and shares linkedConnectionId.
    const stubLeg = edge("eA", "dev", "p-1", "stub-label-1", "in");
    stubLeg.data!.linkedConnectionId = "link-123";
    const otherLeg = edge("eB", "stub-label-2", "out", "tgt", "px");
    otherLeg.data!.linkedConnectionId = "link-123";
    const newTpl = template("Empty", []);
    const plan = planDeviceSwap(oldDev, "dev", newTpl, [stubLeg, otherLeg]);

    expect(plan.mappings).toHaveLength(1);
    expect(plan.mappings[0].newPortRef).toBeNull();
    expect(plan.mappings[0].edges[0].data?.linkedConnectionId).toBe("link-123");
    // The store-side action uses this linkedConnectionId to also drop "otherLeg" + stub labels.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Card carry-over
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — card carry-over", () => {
  it("carries an installed card into a matching empty slot on the new device", () => {
    // Old device has a card installed in slot 'old-slot-A' with family 'test-family'.
    const cardTpl: DeviceTemplate = {
      deviceType: "card",
      label: "Test Card",
      id: "tcard-1",
      slotFamily: "test-family",
      ports: [port("cp-1", "Card OUT 1", "sdi", "output")],
    };
    const oldDev: DeviceData = {
      label: "Chassis",
      deviceType: "chassis",
      ports: [port("op-c-1", "Card OUT 1", "sdi", "output", { templatePortId: "cp-1" })],
      slots: [
        {
          slotId: "old-slot-A",
          label: "Slot A",
          slotFamily: "test-family",
          cardTemplateId: "tcard-1",
          cardLabel: "Test Card",
          portIds: ["op-c-1"],
        },
      ],
    };
    const edges = [edge("e1", "dev", "op-c-1", "tgt", "px")];

    const newTpl = template("New Chassis", [], "new-chassis", [
      { id: "new-slot-X", label: "Slot X", slotFamily: "test-family" },
    ]);

    const plan = planDeviceSwap(oldDev, "dev", newTpl, edges, [cardTpl]);

    expect(plan.installedCards).toHaveLength(1);
    expect(plan.installedCards[0].source).toBe("carried-over");
    expect(plan.installedCards[0].slotId).toBe("new-slot-X");
    expect(plan.cardsLost).toHaveLength(0);
    // The edge should be mapped to the card's port.
    expect(plan.mappings[0].newPortRef?.kind).toBe("card");
    expect(plan.mappings[0].matchSource).toBe("carried-card");
  });

  it("reports cardsLost when no slot family matches", () => {
    const cardTpl: DeviceTemplate = {
      deviceType: "card", label: "Stranded Card", id: "tcard-2",
      slotFamily: "fam-A",
      ports: [port("cp-1", "Card P", "sdi", "output")],
    };
    const oldDev: DeviceData = {
      label: "Old", deviceType: "chassis",
      ports: [port("p-1", "Card P", "sdi", "output")],
      slots: [{
        slotId: "s1", label: "S1", slotFamily: "fam-A",
        cardTemplateId: "tcard-2", cardLabel: "Stranded Card",
        portIds: ["p-1"],
      }],
    };
    // No matching slot families on the new template.
    const newTpl = template("New", [], "new", [
      { id: "s2", label: "S2", slotFamily: "fam-B" },
    ]);
    const plan = planDeviceSwap(oldDev, "dev", newTpl, [], [cardTpl]);
    expect(plan.cardsLost).toHaveLength(1);
    expect(plan.cardsLost[0].cardLabel).toBe("Stranded Card");
    expect(plan.installedCards).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Card auto-install + bin-packing
// ─────────────────────────────────────────────────────────────────────────────

describe("planDeviceSwap — auto-install cards", () => {
  it("auto-installs a card to satisfy an unmapped DisplayPort connection", () => {
    // 4 DisplayPort outputs from old device, none on new template's base ports.
    const oldPorts: Port[] = [];
    for (let i = 1; i <= 4; i++) oldPorts.push(port(`o${i}`, `DP OUT ${i}`, "displayport", "output"));
    const oldDev = deviceData("Old DP Source", oldPorts);
    const edges = oldPorts.map((p, i) => edge(`e${i}`, "dev", p.id, "tgt", "px"));

    // 4-port DisplayPort card available via custom templates.
    const dpCard: DeviceTemplate = {
      deviceType: "card", label: "Quad DP Card", id: "dp-card-4",
      slotFamily: "test-fam",
      ports: [
        port("c1", "DP OUT 1", "displayport", "output"),
        port("c2", "DP OUT 2", "displayport", "output"),
        port("c3", "DP OUT 3", "displayport", "output"),
        port("c4", "DP OUT 4", "displayport", "output"),
      ],
    };

    // New template has empty slot in test-fam family.
    const newTpl = template("New Chassis", [], "ncx", [
      { id: "slot-1", label: "Slot 1", slotFamily: "test-fam" },
    ]);

    const plan = planDeviceSwap(oldDev, "dev", newTpl, edges, [dpCard]);

    // Bin-packing: one card should satisfy all four.
    expect(plan.installedCards).toHaveLength(1);
    expect(plan.installedCards[0].source).toBe("auto-installed");
    expect(plan.installedCards[0].cardTemplateId).toBe("dp-card-4");

    // All four mappings should resolve to the card's ports.
    expect(plan.mappings.every((m) => m.newPortRef?.kind === "card")).toBe(true);
    expect(summarizePlan(plan)).toEqual({ remapped: 4, dropped: 0 });
  });

  it("toggling auto-installed card OFF drops its satisfied connections", () => {
    const oldDev = deviceData("Old", [port("o1", "DP OUT 1", "displayport", "output")]);
    const edges = [edge("e1", "dev", "o1", "tgt", "px")];
    const dpCard: DeviceTemplate = {
      deviceType: "card", label: "DP Card", id: "dp-card",
      slotFamily: "fam",
      ports: [port("c1", "DP OUT 1", "displayport", "output")],
    };
    const newTpl = template("New", [], "n", [{ id: "s", label: "S", slotFamily: "fam" }]);

    let plan = planDeviceSwap(oldDev, "dev", newTpl, edges, [dpCard]);
    expect(plan.mappings[0].newPortRef?.kind).toBe("card");

    plan = toggleAutoInstalledCard(plan, plan.installedCards[0].slotId, false);
    expect(plan.installedCards[0].enabled).toBe(false);
    expect(plan.mappings[0].newPortRef).toBeNull();
    expect(summarizePlan(plan)).toEqual({ remapped: 0, dropped: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual override
// ─────────────────────────────────────────────────────────────────────────────

describe("applyManualMapping", () => {
  it("user can drop a connection by passing null", () => {
    const oldDev = deviceData("Old", [port("o1", "IN 1", "sdi", "input")]);
    const edges = [edge("e1", "x", "px", "dev", "o1")];
    const newTpl = template("New", [port("n1", "IN 1", "sdi", "input")]);
    let plan = planDeviceSwap(oldDev, "dev", newTpl, edges);
    expect(plan.mappings[0].newPortRef).not.toBeNull();
    plan = applyManualMapping(plan, plan.mappings[0].oldHandle, "target", null);
    expect(plan.mappings[0].newPortRef).toBeNull();
    expect(plan.mappings[0].matchSource).toBe("manual");
  });
});
