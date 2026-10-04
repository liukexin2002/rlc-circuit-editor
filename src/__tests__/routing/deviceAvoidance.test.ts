import { describe, it, expect } from "vitest";
import { syntheticFixtures } from "../../routingHarness/syntheticFixtures";
import { routeFixture } from "../../routingHarness/route";
import { computeRoutingMetrics } from "../../routing/scoreRoutes";
import { routingScore } from "../../routing/objective";
import { ROUTING_CANDIDATES, pickBest } from "../../routing/portfolio";

/**
 * Hard-zero guard for "routing connections behind devices." deviceOverlapCount must be 0 — a route
 * must never pass through the body of a device that isn't its own endpoint. The harness
 * (routing:check) already gates this, but that's a separate command; this puts the same invariant in
 * `npm test`, measured on the candidate the APP actually picks (best-of-portfolio), so a regression
 * that threads a device fails the normal test run. nonOrthogonal/unrouted are checked alongside.
 */

const g = globalThis as { __routingParams?: Record<string, number> };

/** Route a fixture through the full portfolio and return the winning candidate's metrics (what the app shows). */
function bestMetrics(fx: ReturnType<typeof syntheticFixtures>[number]) {
  const scored = ROUTING_CANDIDATES.map((c) => {
    g.__routingParams = c.params;
    const { routes } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
    const metrics = computeRoutingMetrics(fx.nodes, fx.edges, routes).metrics;
    return { label: c.label, score: routingScore(metrics), metrics };
  });
  g.__routingParams = undefined;
  const best = pickBest(scored.map((s) => ({ label: s.label, score: s.score })))!;
  return scored.find((s) => s.label === best.label)!.metrics;
}

describe("device avoidance (no route behind a non-endpoint device)", () => {
  for (const fx of syntheticFixtures()) {
    it(`${fx.name}: best-of-portfolio has zero hard-zero violations`, () => {
      const m = bestMetrics(fx);
      expect(m.deviceOverlapCount, "route passes through a non-endpoint device body").toBe(0);
      expect(m.endpointBodyCrossings, "route dips into its own endpoint device body (routes 'behind' it)").toBe(0);
      expect(m.nonOrthogonalSegments, "non-orthogonal segment").toBe(0);
      expect(m.unroutedEdges, "edge produced no route").toBe(0);
    });
  }
});
