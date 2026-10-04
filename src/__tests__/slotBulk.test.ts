import { describe, it, expect } from "vitest";
import { buildBulkSlots } from "../slotBulk";

describe("buildBulkSlots (#194)", () => {
  it("builds count slots numbered from start, sharing one family", () => {
    const slots = buildBulkSlots("Slot", 1, 4, "yamaha-my");
    expect(slots).toEqual([
      { label: "Slot 1", slotFamily: "yamaha-my" },
      { label: "Slot 2", slotFamily: "yamaha-my" },
      { label: "Slot 3", slotFamily: "yamaha-my" },
      { label: "Slot 4", slotFamily: "yamaha-my" },
    ]);
  });

  it("honors a non-1 start (appending to an existing frame)", () => {
    const slots = buildBulkSlots("Slot", 9, 2, "");
    expect(slots.map((s) => s.label)).toEqual(["Slot 9", "Slot 10"]);
    expect(slots.every((s) => s.slotFamily === "")).toBe(true);
  });

  it("respects a custom prefix", () => {
    expect(buildBulkSlots("VFC", 1, 2, "disguise-vfc").map((s) => s.label)).toEqual([
      "VFC 1",
      "VFC 2",
    ]);
  });

  it("returns an empty array for a non-positive count", () => {
    expect(buildBulkSlots("Slot", 1, 0, "")).toEqual([]);
    expect(buildBulkSlots("Slot", 1, -3, "")).toEqual([]);
  });
});
