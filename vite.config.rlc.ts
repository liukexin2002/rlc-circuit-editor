/**
 * Build config for the standalone RLC schematic editor.
 *
 * Deliberately independent from the upstream AV app's vite.config.ts:
 *
 *   - its own web root (`rlc-web/`) so the emitted entry page is `index.html` at the
 *     dist root, which is what a plain static host (GitHub Pages included) serves at `/`;
 *   - `publicDir: false` — the upstream app's marketing assets, PWA icons and robots.txt
 *     are not part of this tool and must not be published with it;
 *   - PWA / service worker OFF. A caching worker would hand testers a stale build after
 *     every update, which is the wrong failure mode for a tool under test;
 *   - `base: "./"` so one artifact works from a domain root AND from a
 *     `/repository-name/` GitHub Pages subpath.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import os from "os";
import { readFileSync } from "fs";

const cacheDir = path.join(os.tmpdir(), "vite-rlc-editor");
const root = path.resolve(__dirname, "rlc-web");
const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  resolve: {
    extensions: [".mjs", ".mts", ".ts", ".tsx", ".js", ".jsx", ".json"],
  },
  plugins: [react()],
  cacheDir,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify("rlc"),
  },
  build: {
    outDir: path.resolve(__dirname, "dist-rlc"),
    emptyOutDir: true,
    target: "es2020",
  },
});
