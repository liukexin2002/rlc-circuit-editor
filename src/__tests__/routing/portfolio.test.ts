import { describe, it, expect } from "vitest";
import { ROUTING_CANDIDATES, pickBest } from "../../routing/portfolio";

describe("portfolio candidate set", () => {
  it("lists the shipped default FIRST (zero-regression / stability invariant)", () => {
    expect(ROUTING_CANDIDATES[0].label).toBe("default");
    expect(ROUTING_CANDIDATES[0].params).toEqual({});
  });

  it("has unique labels and a small, diversified set", () => {
    const labels = ROUTING_CANDIDATES.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.length).toBeGreaterThanOrEqual(4);
    // Kept deliberately small (research: most gain in the first 4–8 well-diversified members).
    // Resist letting this balloon. (A finer-grid CELL_SIZE-10 trio was tried and reverted — it
    // gamed the density-blind objective into a bundled, slow result; see portfolio.ts.)
    expect(labels.length).toBeLessThanOrEqual(10);
  });
});

describe("pickBest", () => {
  it("returns the lowest-score candidate", () => {
    const best = pickBest([
      { label: "a", score: 100 },
      { label: "b", score: 40 },
      { label: "c", score: 70 },
    ]);
    expect(best?.label).toBe("b");
  });

  it("resolves ties to the earliest candidate (keeps default on a tie)", () => {
    const best = pickBest([
      { label: "default", score: 50 },
      { label: "other", score: 50 },
    ]);
    expect(best?.label).toBe("default");
  });

  it("returns null for an empty list", () => {
    expect(pickBest([])).toBeNull();
  });
});
