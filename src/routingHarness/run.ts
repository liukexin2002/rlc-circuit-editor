/**
 * Routing harness CLI. Run with tsx:
 *   npm run routing:report     -> route all fixtures, write JSON + SVG to reports/
 *   npm run routing:check      -> diff metrics vs committed baselines (exit 1 on regression)
 *   npm run routing:baseline   -> overwrite baselines with current metrics
 *
 * Extra flags: --filter <substr> (only matching fixtures), --png (also emit PNG via sharp).
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allFixtures } from "./syntheticFixtures";
import { routeFixture } from "./route";
import { computeRuleReport } from "./metrics";
import { renderFixtureSvg } from "./svgReport";
import { loadBaseline, saveBaseline, diffMetrics, formatDiff } from "./baseline";
import { ROUTING_CANDIDATES, pickBest } from "../routing/portfolio";
import { routingScore } from "../routing/objective";

const REPORTS_DIR = fileURLToPath(new URL("../__tests__/fixtures/routing/reports", import.meta.url));

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const mode = has("--check") ? "check" : has("--update-baselines") ? "baseline" : "report";
  const filter = arg("--filter");
  const wantPng = has("--png");

  const fixtures = (await allFixtures()).filter((f) => !filter || f.name.includes(filter));
  if (fixtures.length === 0) {
    console.error("No fixtures matched.");
    process.exit(1);
  }

  // --portfolio: route every candidate config per fixture, score each via the objective, and report
  // best-of-K vs the shipped default. Measurement only — does not change baselines or pick a winner
  // for --check. Proves/quantifies the portfolio search end-to-end (Phase 1).
  if (has("--portfolio")) {
    const g = globalThis as { __routingParams?: Record<string, number> };
    console.log(`Routing portfolio — ${ROUTING_CANDIDATES.length} candidates — ${fixtures.length} fixture(s)\n`);
    let totalDef = 0, totalBest = 0;
    for (const fx of fixtures) {
      const scored = ROUTING_CANDIDATES.map((c) => {
        g.__routingParams = c.params;
        const { routes, overBudget } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
        const metrics = computeRuleReport({ fixture: fx.name, nodes: fx.nodes, edges: fx.edges, routes, overBudget }).metrics;
        return { label: c.label, score: routingScore(metrics), metrics };
      });
      g.__routingParams = undefined;
      const def = scored[0]; // default is always first
      const best = pickBest(scored.map((s) => ({ label: s.label, score: s.score })))!;
      const bestFull = scored.find((s) => s.label === best.label)!;
      totalDef += def.score; totalBest += best.score;
      const gain = def.score > 0 ? (1 - best.score / def.score) * 100 : 0;
      const tag = best.label === "default" ? "(default already best)" : `won by ${best.label}`;
      console.log(
        `  ${fx.name.padEnd(26)} default=${def.score.toFixed(0).padStart(6)} best=${best.score.toFixed(0).padStart(6)} ` +
        `${gain >= 0.5 ? `(-${gain.toFixed(0)}%)` : "(—)  "} ${tag}\n` +
        `      weave ${def.metrics.weavingPairs}->${bestFull.metrics.weavingPairs}  cross ${def.metrics.crossingPairs}->${bestFull.metrics.crossingPairs}  ` +
        `overlap ${def.metrics.deviceOverlapCount}->${bestFull.metrics.deviceOverlapCount}`,
      );
    }
    const totalGain = totalDef > 0 ? (1 - totalBest / totalDef) * 100 : 0;
    console.log(`\nPortfolio total objective: default=${totalDef.toFixed(0)} best=${totalBest.toFixed(0)} (-${totalGain.toFixed(0)}%)`);
    return;
  }

  if (mode === "report" || wantPng) {
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  }

  let sharp: ((svg: Buffer) => { png: () => { toFile: (p: string) => Promise<unknown> } }) | undefined;
  if (wantPng) {
    const mod = await import("sharp");
    sharp = (mod.default ?? mod) as never;
  }

  let failures = 0;
  console.log(`Routing harness — ${mode} — ${fixtures.length} fixture(s)\n`);

  for (const fx of fixtures) {
    const start = Date.now();
    const { routes, overBudget } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
    const elapsed = Date.now() - start;
    const report = computeRuleReport({
      fixture: fx.name,
      nodes: fx.nodes,
      edges: fx.edges,
      routes,
      overBudget,
    });

    if (mode === "report" || wantPng) {
      const svg = renderFixtureSvg(fx.nodes, fx.edges, routes, report);
      writeFileSync(`${REPORTS_DIR}/${fx.name}.svg`, svg);
      writeFileSync(`${REPORTS_DIR}/${fx.name}.json`, JSON.stringify(report, null, 2) + "\n");
      if (sharp) {
        await sharp(Buffer.from(svg)).png().toFile(`${REPORTS_DIR}/${fx.name}.png`);
      }
    }

    if (mode === "baseline") {
      saveBaseline(fx.name, report.metrics);
      console.log(`  ${fx.name}: baseline written (${elapsed}ms)`);
      continue;
    }

    if (mode === "check") {
      const diff = diffMetrics(loadBaseline(fx.name), report.metrics);
      if (!diff.ok) failures++;
      console.log(formatDiff(fx.name, diff));
      continue;
    }

    // report mode summary line
    const m = report.metrics;
    const flags = [
      m.deviceOverlapCount ? `overlap=${m.deviceOverlapCount}` : "",
      m.unroutedEdges ? `unrouted=${m.unroutedEdges}` : "",
      m.crossingPairs ? `cross=${m.crossingPairs}` : "",
      m.weavingPairs ? `weave=${m.weavingPairs}` : "",
      m.fallbackCount ? `fallback=${m.fallbackCount}` : "",
      overBudget ? "OVER-BUDGET" : "",
    ].filter(Boolean).join(" ");
    console.log(`  ${fx.name}: ${fx.edges.length} edges, ${elapsed}ms  ${flags}`);
  }

  if (mode === "check" && failures > 0) {
    console.error(`\n${failures} fixture(s) regressed.`);
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
