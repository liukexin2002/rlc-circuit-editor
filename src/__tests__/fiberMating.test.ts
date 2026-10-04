import { describe, it, expect } from "vitest";
import { areConnectorsCompatible, needsAdapter } from "../connectorTypes";
import type { ConnectorType } from "../types";

/** LC, SC and ST are treated as interchangeable — a hybrid patch cord bridges any
 *  pair of them in the field, so warning on a mixed run was noise. opticalCON breaks
 *  out to the same family and accepts all three. */
const FIBER_FAMILY: ConnectorType[] = ["lc", "sc", "st", "opticalcon"];

describe("fiber connector mating matrix", () => {
  it("mates every fiber connector with every other, both orders, with no adapter", () => {
    for (const a of FIBER_FAMILY) {
      for (const b of FIBER_FAMILY) {
        expect(areConnectorsCompatible(a, b), `${a} ↔ ${b}`).toBe(true);
        expect(needsAdapter(a, b), `${a} ↔ ${b} adapter`).toBe(false);
      }
    }
  });

  it("keeps opticalCON accepting LC as it always did", () => {
    expect(areConnectorsCompatible("opticalcon", "lc")).toBe(true);
    expect(areConnectorsCompatible("lc", "opticalcon")).toBe(true);
  });

  it("deliberately changes the old LC↔SC warning to a clean mate", () => {
    expect(areConnectorsCompatible("lc", "sc")).toBe(true);
    expect(areConnectorsCompatible("sc", "lc")).toBe(true);
  });

  it("does not extend the family to ribbon or transceiver-cage connectors", () => {
    // MPO/QSFP are multi-fiber ribbon and SFP is a cage, not a termination —
    // no patch cord bridges those to a simplex LC/SC/ST.
    for (const outsider of ["mpo", "qsfp", "qsfp28", "sfp"] as ConnectorType[]) {
      for (const fiber of FIBER_FAMILY) {
        expect(areConnectorsCompatible(fiber, outsider), `${fiber} ↔ ${outsider}`).toBe(false);
      }
    }
  });

  it("leaves non-fiber pairings alone", () => {
    expect(areConnectorsCompatible("lc", "rj45")).toBe(false);
    expect(areConnectorsCompatible("sc", "bnc")).toBe(false);
    expect(areConnectorsCompatible("st", "hdmi")).toBe(false);
    // spot-check unrelated rules still hold
    expect(areConnectorsCompatible("rj45", "ethercon")).toBe(true);
    expect(areConnectorsCompatible("usb-a", "usb-b")).toBe(true);
    expect(needsAdapter("usb-c", "usb-a")).toBe(true);
    expect(areConnectorsCompatible("hdmi", "rj45")).toBe(false);
  });
});
