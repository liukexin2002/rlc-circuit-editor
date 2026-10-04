/**
 * Golden-baseline storage + diffing. Baselines are committed per-fixture metric
 * snapshots; diffMetrics is the regression gate used by both the CLI (--check) and
 * the vitest gate. Hard-zero metrics must always be 0; soft metrics may not exceed
 * baseline + tolerance.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HARD_ZERO_METRICS } from "./metrics";

export const BASELINE_DIR = fileURLToPath(
  new URL("../__tests__/fixtures/routing/baselines", import.meta.url),
);

/** Per-metric allowed regression (current may be at most baseline + tolerance). */
const TOLERANCE: Record<string, number> = {
  detourRatioMax: 0.05,
  detourRatioMean: 0.02,
  // counts default to 0 tolerance (no regression allowed)
};

const HARD_ZERO = new Set<string>(HARD_ZERO_METRICS);

export type Metrics = Record<string, number>;

function baselinePath(fixture: string): string {
  return `${BASELINE_DIR}/${fixture}.json`;
}

export function loadBaseline(fixture: string): Metrics | null {
  const p = baselinePath(fixture);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Metrics;
}

export function saveBaseline(fixture: string, metrics: Metrics): void {
  if (!existsSync(BASELINE_DIR)) mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(baselinePath(fixture), JSON.stringify(metrics, null, 2) + "\n");
}

export interface MetricDiff {
  metric: string;
  baseline: number | null;
  current: number;
  delta: number;
  kind: "regression" | "improvement" | "hard-zero";
}

export interface DiffResult {
  ok: boolean;
  diffs: MetricDiff[];
}

export function diffMetrics(baseline: Metrics | null, current: Metrics): DiffResult {
  const diffs: MetricDiff[] = [];
  let ok = true;

  // No baseline yet: can't judge regression. Only catch a hard-zero metric that is
  // non-zero with nothing to compare against (so a brand-new fixture that already
  // routes cleanly stays clean), but don't fail aesthetic metrics.
  if (!baseline) {
    for (const m of HARD_ZERO) {
      const cur = current[m] ?? 0;
      if (cur !== 0) diffs.push({ metric: m, baseline: null, current: cur, delta: cur, kind: "hard-zero" });
    }
    return { ok, diffs };
  }

  // No-regression vs baseline for every metric. Hard-zero metrics simply carry zero
  // tolerance, so once Phase 2 drives them to 0 any reintroduction regresses.
  for (const [metric, cur] of Object.entries(current)) {
    const base = baseline[metric];
    if (base == null) continue;
    const delta = cur - base;
    const tol = HARD_ZERO.has(metric) ? 0 : TOLERANCE[metric] ?? 0;
    if (delta > tol) {
      ok = false;
      diffs.push({ metric, baseline: base, current: cur, delta, kind: HARD_ZERO.has(metric) ? "hard-zero" : "regression" });
    } else if (delta < -tol) {
      diffs.push({ metric, baseline: base, current: cur, delta, kind: "improvement" });
    }
  }

  return { ok, diffs };
}

export function formatDiff(fixture: string, result: DiffResult): string {
  if (result.diffs.length === 0) return `  ${fixture}: ok (no changes)`;
  const lines = result.diffs.map((d) => {
    const arrow = d.kind === "improvement" ? "↓ improved" : d.kind === "hard-zero" ? "✗ HARD-ZERO" : "✗ REGRESSED";
    const sign = d.delta > 0 ? "+" : "";
    return `    ${arrow}  ${d.metric}: ${d.baseline} → ${d.current} (${sign}${Math.round(d.delta * 1000) / 1000})`;
  });
  return `  ${fixture}: ${result.ok ? "ok" : "FAIL"}\n${lines.join("\n")}`;
}
