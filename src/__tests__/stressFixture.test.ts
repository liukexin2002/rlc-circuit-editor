import { describe, it, expect } from "vitest";
import { buildStressSchematic } from "../testSchematic/stress";
import type { DeviceData } from "../types";

/**
 * Guards for the generated stress fixture (`?fixture=stress`). It exists to
 * exercise scale — mass drags, marquee sweeps, big-bounds exports — so the
 * properties worth pinning are its size, its wiring validity, and determinism.
 */
describe("stress fixture", () => {
  const file = buildStressSchematic();

  it("is big enough to reproduce the #384 report (~100+ devices)", () => {
    expect(file.nodes.length).toBeGreaterThanOrEqual(100);
    expect(file.edges.length).toBeGreaterThanOrEqual(90);
  });

  it("every edge references a real device and a matching port handle", () => {
    const byId = new Map(file.nodes.map((n) => [n.id, n]));
    for (const e of file.edges) {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      expect(src, `edge ${e.id} source`).toBeDefined();
      expect(tgt, `edge ${e.id} target`).toBeDefined();
      const srcPorts = (src!.data as DeviceData).ports.map((p) => p.id);
      const tgtPorts = (tgt!.data as DeviceData).ports.map((p) => p.id);
      expect(srcPorts, `edge ${e.id} sourceHandle`).toContain(e.sourceHandle);
      expect(tgtPorts, `edge ${e.id} targetHandle`).toContain(e.targetHandle);
    }
  });

  it("connects like signal types only", () => {
    const byId = new Map(file.nodes.map((n) => [n.id, n]));
    for (const e of file.edges) {
      const srcPort = (byId.get(e.source)!.data as DeviceData).ports.find((p) => p.id === e.sourceHandle);
      const tgtPort = (byId.get(e.target)!.data as DeviceData).ports.find((p) => p.id === e.targetHandle);
      expect(srcPort!.signalType).toBe(tgtPort!.signalType);
      expect(srcPort!.direction).toBe("output");
      expect(tgtPort!.direction).toBe("input");
    }
  });

  it("edges match the app's real edge shape (no type, inline var() stroke)", () => {
    // Caught as wireless PNG exports on the 2026-09-05-2 test pass: an
    // unregistered `type` falls back to React Flow's default bezier, and a
    // missing inline stroke leaves the wire on a stylesheet var() that
    // Chromium's html-to-image clone drops (#173).
    for (const e of file.edges) {
      expect(e.type).toBeUndefined();
      expect(e.style?.stroke).toMatch(/^var\(--color-[a-z-]+\)$/);
    }
  });

  it("is deterministic — two builds are identical", () => {
    expect(buildStressSchematic()).toEqual(file);
  });
});
