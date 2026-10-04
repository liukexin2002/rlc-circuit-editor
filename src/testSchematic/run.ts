/**
 * Generate schematic.json from the typed builder — the same runner shape as
 * routingHarness/run.ts and reportsHarness/run.ts.
 *
 *   npm run fixture:build    # write
 *   npm run fixture:check    # verify in sync
 *
 * The committed JSON is what the app loads; the builder is what humans edit.
 * `--check` keeps the two from drifting (the fixture test runs the same check).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestSchematic } from "./build";

const OUT_PATH = fileURLToPath(new URL("./schematic.json", import.meta.url));

const check = process.argv.includes("--check");
const rendered = JSON.stringify(buildTestSchematic(), null, 2) + "\n";

if (check) {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : "";
  if (current !== rendered) {
    console.error(
      `${path.relative(process.cwd(), OUT_PATH)} is out of date.\n` +
        "Run `npm run fixture:build` and commit the result.",
    );
    process.exit(1);
  }
  console.log("Test schematic is in sync with the builder.");
} else {
  writeFileSync(OUT_PATH, rendered);
  const data = buildTestSchematic();
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT_PATH)} — v${data.version}, ` +
      `${data.nodes.length} nodes, ${data.edges.length} connections, ` +
      `${data.ownedGear?.length ?? 0} owned-gear entries.`,
  );
}
