import { describe, it, expect } from "vitest";
import { syntheticFixtures } from "../routingHarness/syntheticFixtures";
import { defaultSchematicFixture } from "../routingHarness/fixtures";
import { routeFixture } from "../routingHarness/route";
import { computeRuleReport } from "../routingHarness/metrics";
import { loadBaseline, diffMetrics, formatDiff } from "../routingHarness/baseline";
import { deviceContentHeight } from "../routingHarness/deviceHandleLayout";
import type { DeviceData } from "../types";

const fixtures = [...syntheticFixtures(), defaultSchematicFixture()];

describe("routing harness — no regression vs baseline", () => {
  for (const fx of fixtures) {
    it(`${fx.name} does not regress`, () => {
      const { routes, overBudget } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
      const report = computeRuleReport({
        fixture: fx.name,
        nodes: fx.nodes,
        edges: fx.edges,
        routes,
        overBudget,
      });
      const baseline = loadBaseline(fx.name);
      expect(baseline, `missing baseline for "${fx.name}" — run \`npm run routing:baseline\``).not.toBeNull();
      const diff = diffMetrics(baseline, report.metrics);
      if (!diff.ok) throw new Error(`\n${formatDiff(fx.name, diff)}`);
      expect(diff.ok).toBe(true);
    });
  }
});

describe("bundles route onto one clean shared trunk", () => {
  const bundleFixtures = syntheticFixtures().filter((f) => f.name.startsWith("bundle-"));
  for (const fx of bundleFixtures) {
    it(`${fx.name}: no device overlaps, no unrouted, one trunk per bundle`, () => {
      const { routes } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
      const report = computeRuleReport({
        fixture: fx.name, nodes: fx.nodes, edges: fx.edges, routes, overBudget: false,
      });
      expect(report.metrics.deviceOverlapCount).toBe(0);
      expect(report.metrics.unroutedEdges).toBe(0);
      expect(report.metrics.nonOrthogonalSegments).toBe(0);
      // One synthetic trunk route emitted per declared bundle.
      const trunkKeys = Object.keys(routes).filter((k) => k.startsWith("bundle:"));
      expect(trunkKeys.sort()).toEqual(Object.keys(fx.bundles ?? {}).map((id) => `bundle:${id}`).sort());
    });
  }
});

describe("device handle layout pin", () => {
  // The mock handle synthesis is only correct if our device-height model matches
  // DeviceNode's actual render. defaultSchematic was saved with default toggles, so
  // computed height must equal the stored measured.height for every device.
  it("computed device height matches measured.height in defaultSchematic", () => {
    const { nodes } = defaultSchematicFixture();
    const mismatches: string[] = [];
    for (const n of nodes) {
      if (n.type !== "device" || !n.measured?.height) continue;
      const computed = deviceContentHeight({ data: n.data as DeviceData, measured: n.measured });
      if (computed !== n.measured.height) {
        mismatches.push(`${n.id} (${(n.data as DeviceData).label}): computed ${computed} vs measured ${n.measured.height}`);
      }
    }
    if (mismatches.length) throw new Error(`Handle-layout drift:\n  ${mismatches.join("\n  ")}`);
    expect(mismatches).toHaveLength(0);
  });
});
