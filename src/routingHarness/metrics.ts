/**
 * Rule-checker: scores a routed fixture against the R1–R11 routing rules plus aesthetic metrics.
 * This is the harness's oracle. The metric COMPUTATION now lives in src/routing/scoreRoutes.ts
 * (`computeRoutingMetrics`) so the harness and the in-worker portfolio scorer share one definition;
 * this file just wraps it with the report envelope (fixture name, counts, warnings).
 *
 * Hard-zero metrics (a clean route must score 0): deviceOverlapCount (R1),
 * nonOrthogonalSegments (R3), unroutedEdges. Everything else is a soft quality metric tracked
 * against a per-fixture baseline.
 */

import type { SchematicNode, ConnectionEdge } from "../types";
import { computeRoutingMetrics } from "../routing/scoreRoutes";

export interface RuleReport {
  fixture: string;
  deviceCount: number;
  edgeCount: number;
  routedCount: number;
  overBudget: boolean;
  metrics: Record<string, number>;
  offenders: Record<string, string[]>;
  warnings: string[];
}

export function computeRuleReport(opts: {
  fixture: string;
  nodes: SchematicNode[];
  edges: ConnectionEdge[];
  routes: Record<string, { waypoints: { x: number; y: number }[]; turns?: string }>;
  overBudget: boolean;
}): RuleReport {
  const { fixture, nodes, edges, routes, overBudget } = opts;
  const { metrics, offenders, deviceCount, routedCount, unroutedCount } = computeRoutingMetrics(
    nodes,
    edges,
    routes,
  );

  const warnings: string[] = [];
  if (overBudget) warnings.push("routing exceeded time budget (partial/fallback routes)");
  if (unroutedCount) warnings.push(`${unroutedCount} edge(s) produced no route`);

  return {
    fixture,
    deviceCount,
    edgeCount: edges.length,
    routedCount,
    overBudget,
    metrics,
    offenders,
    warnings,
  };
}

/** Metrics that must be exactly 0 for a routing run to be considered correct. */
export const HARD_ZERO_METRICS = [
  "deviceOverlapCount",
  "endpointBodyCrossings",
  "nonOrthogonalSegments",
  "unroutedEdges",
] as const;
