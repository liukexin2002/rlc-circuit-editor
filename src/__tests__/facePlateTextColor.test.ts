// #301 — the face-plate editor paints the device header color as its plate
// background but hardcoded white for the device label, section labels, and port
// labels, so a pale header (the exact case the rack views fixed) rendered
// white-on-white. The editor must make the same black/white choice as
// RackFaceSVG / RackRenderer: contrastingTextColor for solid text, and the
// alpha'd secondary labels flip to dark-alpha over light backgrounds.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FacePlateEditor from "../components/FacePlateEditor";
import type { DeviceData } from "../types";

const noop = () => {};

function renderFacePlate(headerColor: string): string {
  const deviceData: DeviceData = {
    label: "Test Device",
    deviceType: "video-processor",
    headerColor,
    // 2U so the plate is tall enough for port labels to render.
    heightMm: 88,
    ports: [
      { id: "p1", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
    ],
    facePlateLayout: {
      positions: { p1: { x: 50, y: 60 } },
      labels: [{ id: "l1", text: "MAIN", x: 20, y: 10 }],
    },
  };
  return renderToStaticMarkup(createElement(FacePlateEditor, { deviceData, onSave: noop, onClose: noop }));
}

describe("face-plate editor text contrast (#301)", () => {
  it("renders black labels on a pale-yellow header", () => {
    const svg = renderFacePlate("#fde047");
    expect(svg).toContain('fill="#000000"'); // device label
    expect(svg).toContain('fill="rgba(0,0,0,0.6)"'); // section label
    expect(svg).toContain('fill="rgba(0,0,0,0.8)"'); // port label
    expect(svg).not.toContain('fill="rgba(255,255,255,0.6)"');
    expect(svg).not.toContain('fill="rgba(255,255,255,0.8)"');
  });

  it("keeps white labels on a black header", () => {
    const svg = renderFacePlate("#000000");
    expect(svg).toContain('fill="#ffffff"'); // device label
    expect(svg).toContain('fill="rgba(255,255,255,0.6)"'); // section label
    expect(svg).toContain('fill="rgba(255,255,255,0.8)"'); // port label
    expect(svg).not.toContain('fill="rgba(0,0,0,0.6)"');
    expect(svg).not.toContain('fill="rgba(0,0,0,0.8)"');
  });
});
