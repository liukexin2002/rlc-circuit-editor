/**
 * Stage the v1 freeze for the gh-pages branch.
 *
 * Writes the currently-deployed v1 files into v1/ using the raw bytes git has for them, so no
 * text encoding (BOM) is introduced by the shell. Then removes the old root-level assets, which
 * nothing references any more now that v2 owns the root.
 *
 * Run from the repo root while checked out on the deploy branch.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const V1_FILES = ["index.html", "assets/index-BJx7-6qG.css", "assets/index-D9qwG95q.js"];

for (const rel of V1_FILES) {
  const buf = execFileSync("git", ["show", `HEAD:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
  const dest = `v1/${rel}`;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`v1/${rel}  ${buf.length} bytes`);
}

// The root no longer references v1's asset hashes, so drop the duplicates.
for (const rel of ["assets/index-BJx7-6qG.css", "assets/index-D9qwG95q.js"]) {
  if (existsSync(rel)) {
    rmSync(rel);
    console.log(`removed stale root asset: ${rel}`);
  }
}

// Sanity: each page must reference assets that actually exist next to it.
const checkRefs = (file: string, prefix: string) => {
  const html = readFileSync(file, "utf8");
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    const p = `${prefix}${r}`;
    console.log(`${file} -> ${p} ${existsSync(p) ? "OK" : "MISSING"}`);
  }
};
checkRefs("index.html", "");
checkRefs("v1/index.html", "v1/");
