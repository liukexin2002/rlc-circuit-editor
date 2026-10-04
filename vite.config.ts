import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import os from 'os'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

// Use temp dir for cache to avoid file-locking issues
const cacheDir = path.join(os.tmpdir(), 'vite-easyschematic')

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

let gitHash = 'unknown'
try {
  gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
} catch { /* not a git repo or git not available */ }

export default defineConfig({
  // Resolve TypeScript sources before .js so stale emitted .js shadows can't silently win.
  resolve: {
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt' lets src/sw-register.ts decide what to do when a new SW
      // arrives — show a pill when the user's active, silent-reload when
      // they're idle. 'autoUpdate' would swallow onNeedRefresh and force a
      // silent reload on every update, even mid-interaction.
      registerType: 'prompt',
      // We call registerSW() manually from src/main.tsx; don't let the plugin
      // auto-inject a second registration script.
      injectRegister: false,
      workbox: {
        // No skipWaiting/clientsClaim — those would auto-activate the new SW
        // and immediately reload via vite-plugin-pwa's controlling listener,
        // which races our pill out of existence. The pill (src/sw-register.ts
        // → updateSW(true)) is now what skips waiting and reloads, on the
        // user's terms or after they go idle.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,ttf,json}'],
        globIgnores: [
          '**/deviceLibrary.fallback.json',
          '**/og-image.png',
          '**/github-social.png',
          '**/landing-screenshot.png',
          '**/email-logo.png',
        ],
      },
      manifest: {
        name: 'EasySchematic — AV Signal Flow Diagram Tool',
        short_name: 'EasySchematic',
        description: 'Design audio/video signal flow diagrams for broadcast, live production, and AV integration.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  cacheDir,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(gitHash),
  },
})
