/**
 * Entry point for the standalone RLC schematic editor.
 *
 * Deliberately separate from the upstream AV app's entry (src/main.tsx): this editor is a
 * self-contained tool whose only dependency is the routing engine, so it gets its own
 * entry, its own stylesheet and its own build target (see vite.config.rlc.ts).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RlcEditorApp } from "./RlcEditorApp";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <RlcEditorApp />
  </StrictMode>,
);
