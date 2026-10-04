/**
 * Acceptance tests for the DELIVERED link (live GitHub Pages).
 *
 * These drive the deployed site — not a local build — so what passes here is what a visitor
 * actually gets. The v2 additions are checked on measured geometry:
 *
 *   - the junction really lies on the host wire's rendered path
 *   - the branch really is orthogonal
 *   - the existing wire's rendered path is UNCHANGED by the tap (string-identical <path d>)
 *   - reopening the page redraws the SAME geometry rather than a fresh route
 *   - the exported netlist is structurally what scikit-rf's Circuit accepts
 *   - v1 is still reachable at /v1/ and still v1
 */

import { expect, test, type Page } from "@playwright/test";

const LIVE_URL = process.env.RLC_LIVE_URL ?? "https://liukexin2002.github.io/rlc-circuit-editor/";

// ── helpers ─────────────────────────────────────────────────────────────────

async function dragOn(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function dragPartBy(page: Page, index: number, dy: number) {
  const box = await page.locator("g.rlc-symbol").nth(index).boundingBox();
  if (!box) throw new Error(`symbol #${index} has no box`);
  await dragOn(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy },
  );
}

/** Screen position of the n-th pin with this id (one pin of each id per part). */
async function pinPoint(page: Page, partIndex: number, pinId: "p0" | "p1") {
  const box = await page.locator(`[data-pin-id="${pinId}"]`).nth(partIndex).boundingBox();
  if (!box) throw new Error(`pin ${pinId} of part #${partIndex} not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function placeFromPalette(page: Page, name: string) {
  const before = await page.locator("g.rlc-symbol").count();
  await page.locator(".rlc-part", { hasText: name }).click();
  await expect(page.locator("g.rlc-symbol")).toHaveCount(before + 1);
  const box = await page.locator("g.rlc-symbol").nth(before).boundingBox();
  if (!box) throw new Error("placed symbol has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Midpoint of the LONGEST segment of the first wire, mapped to screen coordinates. */
async function pointOnFirstWire(page: Page) {
  const d = await page.locator("path.rlc-wire-hit").first().getAttribute("d");
  const pts = [...(d ?? "").matchAll(/[MLQ]\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
  if (pts.length < 2) throw new Error("wire has no path");
  let best = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  let longest = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    if (len > longest) {
      longest = len;
      best = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
    }
  }
  const screen = await page.evaluate((w) => {
    const g = document.querySelector('[data-testid="rlc-viewport"]') as SVGGElement | null;
    const ctm = g?.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(w.x, w.y).matrixTransform(ctm);
    return { x: pt.x, y: pt.y };
  }, best);
  if (!screen) throw new Error("could not map the wire point to screen coordinates");
  return screen;
}

/** Rendered wire paths, in document order. */
async function wirePaths(page: Page) {
  return page.locator("path.rlc-wire").evaluateAll((els) => els.map((e) => e.getAttribute("d") ?? ""));
}

function parsePath(d: string) {
  return [...d.matchAll(/[MLQ]\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

function isOrthogonal(pts: { x: number; y: number }[]) {
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i].x - pts[i - 1].x) > 0.01 && Math.abs(pts[i].y - pts[i - 1].y) > 0.01) return false;
  }
  return true;
}

/** Two parts joined by one wire, plus a third part dragged clear to tap with. */
async function setup(page: Page) {
  await placeFromPalette(page, "电阻");
  await placeFromPalette(page, "电容");
  const p1 = await pinPoint(page, 0, "p1");
  await page.mouse.click(p1.x, p1.y);
  const p0 = await pinPoint(page, 1, "p0");
  await page.mouse.click(p0.x, p0.y);
  await expect(page.locator(".rlc-status")).toContainText("连线 1");
  await placeFromPalette(page, "电感");
  await dragPartBy(page, 2, 260);
  await expect(page.locator(".rlc-status")).toContainText("降级连线 0");
}

async function tap(page: Page) {
  const from = await pinPoint(page, 2, "p0");
  await page.mouse.click(from.x, from.y);
  const onWire = await pointOnFirstWire(page);
  await page.mouse.move(onWire.x, onWire.y);
  await page.mouse.click(onWire.x, onWire.y);
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe("LIVE v2 — delivered link", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("元件 0");
  });

  test("the live page boots and shows the v2 badge plus the netlist panel", async ({ page }) => {
    await expect(page).toHaveTitle(/RLC/);
    await expect(page.getByTestId("rlc-version")).toHaveText(/v2/);
    await expect(page.locator(".rlc-part")).toHaveCount(3);
    // The panel's summary is always there; the per-net list appears once nets exist, so it is
    // asserted after placing a part rather than on an empty document.
    await expect(page.getByTestId("rlc-netlist-info")).toBeVisible();
    await placeFromPalette(page, "电阻");
    // The per-net list is present once a net exists. It is asserted by EXISTENCE rather than by
    // visibility: the side panel scrolls, and whether the row is currently scrolled into view
    // says nothing about the feature.
    await expect(page.getByTestId("rlc-netlist")).toHaveCount(1);
    await expect(page.getByTestId("rlc-netlist")).toContainText("R1.p0");
  });

  test("place, rotate, connect, and the wire is orthogonal and unobstructed", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");
    await expect(page.locator(".rlc-status")).toContainText("元件 2");

    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");

    const paths = await wirePaths(page);
    expect(paths.length).toBe(1);
    const pts = parsePath(paths[0]);
    expect(isOrthogonal(pts)).toBe(true);
  });

  test("hovering a wire while connecting highlights it and previews the junction", async ({ page }) => {
    await setup(page);
    const from = await pinPoint(page, 2, "p0");
    await page.mouse.click(from.x, from.y);
    await expect(page.locator(".rlc-side")).toContainText("正在连线");

    const onWire = await pointOnFirstWire(page);
    await page.mouse.move(onWire.x, onWire.y);
    await expect(page.locator("path.rlc-wire-hovered")).toHaveCount(1);
    await expect(page.getByTestId("rlc-tap-preview")).toBeVisible();
    await expect(page.getByTestId("rlc-junction-preview")).toBeVisible();
  });

  test("connecting a pin to a wire creates a junction that lies ON the wire", async ({ page }) => {
    await setup(page);
    const hostBefore = (await wirePaths(page))[0];

    await tap(page);
    await expect(page.locator(".rlc-status")).toContainText("连线 2");
    await expect(page.locator(".rlc-status")).toContainText("结点 1");

    const paths = await wirePaths(page);
    expect(paths.length).toBe(2);
    // The host wire must be UNCHANGED: string-identical path data.
    expect(paths[0], "the host wire must not move").toBe(hostBefore);

    const branch = parsePath(paths[1]);
    expect(isOrthogonal(branch), `branch must be orthogonal: ${paths[1]}`).toBe(true);

    // The junction (the branch's endpoint) must lie on a segment of the host.
    const host = parsePath(hostBefore);
    const j = branch[branch.length - 1];
    let onHost = false;
    for (let i = 1; i < host.length; i++) {
      const a = host[i - 1];
      const b = host[i];
      if (
        j.x >= Math.min(a.x, b.x) - 0.5 &&
        j.x <= Math.max(a.x, b.x) + 0.5 &&
        j.y >= Math.min(a.y, b.y) - 0.5 &&
        j.y <= Math.max(a.y, b.y) + 0.5
      ) {
        onHost = true;
        break;
      }
    }
    expect(onHost, `junction ${JSON.stringify(j)} must be on the host wire`).toBe(true);
    await expect(page.locator("circle.rlc-junction")).toHaveCount(1);
  });

  test("the tapped node joins the host's net in the netlist panel", async ({ page }) => {
    await setup(page);
    const before = await page.locator("[data-testid='rlc-netlist'] .rlc-net-row").count();
    await tap(page);
    await tap(page); // ignored: the pin is already consumed by the first tap

    await expect(page.getByTestId("rlc-netlist-info")).toContainText("连接点（Steiner 点）1");
    const netRows = page.locator("[data-testid='rlc-netlist'] .rlc-net-row");
    // One fewer node than before: the tapper joined the trunk instead of standing alone.
    expect(await netRows.count()).toBeLessThan(before);
  });

  test("a tap survives a reload with byte-identical geometry", async ({ page }) => {
    await setup(page);
    await tap(page);
    await expect(page.locator(".rlc-status")).toContainText("连线 2");
    const before = await wirePaths(page);

    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("连线 2");
    await expect(page.locator("circle.rlc-junction")).toHaveCount(1);

    const after = await wirePaths(page);
    expect(after, "reopening must redraw the stored geometry, not re-route").toEqual(before);
  });

  test("undo removes the tap and redo restores it", async ({ page }) => {
    await setup(page);
    await tap(page);
    await expect(page.locator(".rlc-status")).toContainText("连线 2");

    await page.keyboard.press("Control+z");
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    await expect(page.locator(".rlc-status")).toContainText("结点 0");

    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".rlc-status")).toContainText("连线 2");
    await expect(page.locator("circle.rlc-junction")).toHaveCount(1);
  });

  test("the exported netlist is structurally valid for scikit-rf", async ({ page }) => {
    await setup(page);
    await tap(page);

    const json = await page.evaluate(() => {
      const w = window as unknown as { __rlcExportNetlist?: () => string };
      return w.__rlcExportNetlist ? w.__rlcExportNetlist() : null;
    });
    expect(json, "the live page must expose the netlist export").not.toBeNull();
    const netlist = JSON.parse(json!);

    expect(netlist.format).toContain("rlc-schematic-netlist");
    expect(netlist.frequency.npoints).toBeGreaterThan(0);

    // Unique network names (Circuit raises on duplicates).
    const names = netlist.networks.map((n: { name: string }) => n.name);
    expect(new Set(names).size).toBe(names.length);

    // No (network, port) pair appears in two nodes (Circuit raises on duplicates).
    const seen = new Set<string>();
    for (const group of netlist.connections) {
      expect(group.length).toBeGreaterThan(0);
      for (const [n, p] of group) {
        expect(names, `connection references ${n}`).toContain(n);
        const key = `${n}#${p}`;
        expect(seen.has(key), `(${n}, ${p}) must appear once`).toBe(false);
        seen.add(key);
      }
    }

    // The tap is visible in the netlist: exactly one wire ends on another wire.
    const wires = netlist.schematic.wires as { from: { kind: string }; to: { kind: string } }[];
    const taps = wires.filter((w) => w.from.kind === "tap" || w.to.kind === "tap");
    expect(taps.length).toBe(1);
    // ...and every wire carries its solved polyline, so the drawing can be restored.
    expect(wires.every((w: { waypoints: unknown[] }) => w.waypoints.length >= 2)).toBe(true);

    // R/L/C values are SI numbers.
    for (const n of netlist.networks as { kind: string; value?: number }[]) {
      if (["resistor", "inductor", "capacitor"].includes(n.kind)) {
        expect(typeof n.value).toBe("number");
        expect(Number.isFinite(n.value!)).toBe(true);
      }
    }
  });
});

test.describe("LIVE v1 — frozen archive", () => {
  test("v1 is still served and is the v1 build", async ({ page }) => {
    await page.goto(`${LIVE_URL}v1/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("元件 0");
    // v1 has no version badge and no netlist panel.
    await expect(page.getByTestId("rlc-version")).toHaveCount(0);
    await expect(page.getByTestId("rlc-netlist")).toHaveCount(0);
    // The v1 gesture set still works: place and connect pin to pin.
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");
    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
  });
});
