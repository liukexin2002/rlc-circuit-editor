import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import os from "os";

const cacheDir = path.join(os.tmpdir(), "vite-easyschematic-devices");

export default defineConfig({
  cacheDir,
  plugins: [
    react(),
    VitePWA({
      // 'prompt' lets src/sw-register.ts decide what to do when a new SW
      // arrives — show a pill when the user's active, silent-reload when
      // they're idle. Mirrors the main app; see reference_pwa_sw_update.
      registerType: "prompt",
      // We call registerSW() manually from src/main.tsx; don't let the plugin
      // auto-inject a second registration script.
      injectRegister: false,
      workbox: {
        // No skipWaiting/clientsClaim — those would auto-activate the new SW
        // and immediately reload, racing our update pill out of existence. The
        // pill (src/sw-register.ts → updateSW(true)) is what skips waiting and
        // reloads, on the user's terms or once they go idle.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Precache the app shell + fonts (two Inter .ttf files) so the site
        // loads with no network on a repeat visit. txt/xml are included so the
        // SW serves robots.txt / sitemap.xml directly instead of navigateFallback
        // handing them the SPA shell once the SW controls the page.
        globPatterns: ["**/*.{js,css,html,svg,png,ttf,txt,xml}"],
        // Client-side routes (/device/:id, /submit, ...) have no real file on
        // disk — serve the SPA shell for any navigation so they resolve offline.
        navigateFallback: "/index.html",
      },
      manifest: {
        name: "EasySchematic Device Library",
        short_name: "ES Devices",
        description: "Browse professional AV device templates with detailed port and signal type specifications.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
  // Resolve TypeScript sources before .js so stale emitted .js shadows can't silently win.
  resolve: {
    extensions: [".mjs", ".mts", ".ts", ".tsx", ".js", ".jsx", ".json"],
  },
});
