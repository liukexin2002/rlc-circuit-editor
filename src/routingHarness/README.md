# Routing harness

Headless oracle for the auto-router. Runs the real `routeAllEdges` (`src/edgeRouter.ts`) with no
browser, via a mock React-Flow instance, and scores the result against the R1–R11 rules plus
aesthetic metrics. **This is what gates every routing change** — not `npm test` alone.

## Add a new example schematic

Adding a fixture is drop-in — no code:

1. In the app, export the schematic to JSON.
2. Drop the file into `src/__tests__/fixtures/routing/`. Real client exports are **gitignored** on
   purpose (public repo); only the synthetic fixtures and `defaultSchematic` baselines are
   committed. `loadFileFixtures` auto-discovers any `*.json` there.
3. `npm run routing:report -- --filter "<file stem>"` writes `reports/<name>.json` + `<name>.svg`.
4. A partly-hand-routed file also gets a `<name>__auto` variant with `manualWaypoints` stripped —
   **that variant is the pure auto-router quality signal; weight it** over the as-saved one (whose
   metrics largely measure user-placed routes).
5. Eyeball the `.svg` (open in a browser, or add `--png` and open the PNG). Track guides are the
   faint dashed verticals — they show where each edge's vertical trunk sits, so corridor packing
   and concentric nesting are visible at a glance.

## Commands

| Command | Does |
|---|---|
| `npm run routing:report` | Route all fixtures → write JSON + SVG to `reports/`. |
| `npm run routing:check`  | Diff metrics vs committed baselines; exit 1 on regression (the gate). |
| `npm run routing:baseline` | Overwrite baselines with current metrics (after an *intended* change). |

Extra flags: `-- --filter <substr>` (only matching fixtures), `-- --png` (also emit PNG via sharp).

## Metrics that matter

Per the VLSI / graph-drawing research behind the track-assignment engine
(`~/.claude/plans/routing-track-engine.md`):

- **`crossingPairs`, `weavingPairs`** — primary aesthetic targets (lower = better).
- **`turnsTotal`** — bend count (lower = better).
- **`channelDensity` vs `distinctTrackXs`** — packing quality. `channelDensity` is the lower bound
  on tracks (max trunks overlapping in one channel); when `distinctTrackXs` is close to it, packing
  is near-optimal. A big gap means wasted columns.
- **`doglegCount`** — trunks split to break a vertical-constraint cycle (backward/same-side edges).
- **`deviceOverlapCount`, `nonOrthogonalSegments`, `unroutedEdges`** — HARD-ZERO; must never
  increase (see `HARD_ZERO_METRICS` in `metrics.ts`).
- **`detourRatioMax/Mean`** — the guardrail. A change that slashes crossings but explodes detour is
  suspect (it's how the abandoned "Step A" backward-corridor hack regressed).

## Determinism

`routing:check` runs with `__routingParams` unset; all router sorts have explicit `id`
tie-breakers. Same input → same routes.
