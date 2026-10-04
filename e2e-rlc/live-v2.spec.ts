/**
 * Acceptance tests for the DELIVERED link (live GitHub Pages).
 *
 * These drive the deployed site — not a local build — so what passes here is what a visitor
 * gets. The v2 features under test, on MEASURED geometry rather than on descriptions:
 *
 *   - a wire is orthogonal and its solved polyline is stored with the document
 *   - reopening the page redraws the SAME geometry instead of a fresh route (string-identical
 *     <path d> attributes)
 *   - adding a wire leaves an existing wire's rendered path unchanged
 *   - the exported netlist is structurally what scikit-rf's Circuit accepts
 *   - v1 is still reachable at /v1/ and still v1
 */

import { expect, test, type Page } from "@playwright/test";

const LIVE_URL = process.env.RLC_LIVE_URL ?? "https://liukexin2002.github.io/rlc-circuit-editor/";

// ── helpers ─────────────────────────────────────────────────────────────────

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

/** Two parts joined by one wire. */
async function setup(page: Page) {
  await placeFromPalette(page, "电阻");
  await placeFromPalette(page, "电容");
  const p1 = await pinPoint(page, 0, "p1");
  await page.mouse.click(p1.x, p1.y);
  const p0 = await pinPoint(page, 1, "p0");
  await page.mouse.click(p0.x, p0.y);
  await expect(page.locator(".rlc-status")).toContainText("连线 1");
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

  test("the live page boots with the editor, the netlist panel and a version badge", async ({ page }) => {
    await expect(page).toHaveTitle(/RLC/);
    await expect(page.locator(".rlc-part")).toHaveCount(3);
    await expect(page.getByTestId("rlc-version")).toHaveText(/v2/);
    // The panel summary is always present; the per-net list appears once nets exist.
    await expect(page.getByTestId("rlc-netlist-info")).toBeVisible();
    await placeFromPalette(page, "电阻");
    await expect(page.getByTestId("rlc-netlist")).toHaveCount(1);
    await expect(page.getByTestId("rlc-netlist")).toContainText("R1.p0");
  });

  test("place, rotate, connect — the wire is orthogonal and unobstructed", async ({ page }) => {
    await setup(page);
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");

    const paths = await wirePaths(page);
    expect(paths.length).toBe(1);
    expect(isOrthogonal(parsePath(paths[0]))).toBe(true);

    // Rotating a part keeps it selected and updates the panel.
    await placeFromPalette(page, "电感");
    const c = await page.locator("g.rlc-symbol").nth(2).boundingBox();
    await page.mouse.click(c!.x + c!.width / 2, c!.y + c!.height / 2);
    await expect(page.locator(".rlc-side")).toContainText("位号");
    await page.keyboard.press("r");
    await expect(page.locator(".rlc-side select")).toHaveValue("90");
  });

  test("reopening redraws the saved geometry, byte for byte", async ({ page }) => {
    await setup(page);
    const before = await wirePaths(page);
    expect(before.length).toBe(1);

    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    const after = await wirePaths(page);
    expect(after, "reopening must replay the stored polyline, not a fresh solve").toEqual(before);
  });

  test("adding a second wire leaves the first wire's path unchanged", async ({ page }) => {
    await setup(page);

    // Place the third part and MOVE IT CLEAR before touching the wires. Placing a part adds an
    // obstacle, which legitimately re-routes whatever it lands on — so the part has to be out
    // of the way first, and only the act of ADDING A WIRE is under test here.
    await placeFromPalette(page, "电感");
    const box = await page.locator("g.rlc-symbol").nth(2).boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 260, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const firstBefore = (await wirePaths(page))[0];
    const degradedBefore = await page.locator(".rlc-status").innerText();

    const a = await pinPoint(page, 2, "p0");
    await page.mouse.click(a.x, a.y);
    const b = await pinPoint(page, 1, "p1");
    await page.mouse.click(b.x, b.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 2");

    const paths = await wirePaths(page);
    expect(paths.length).toBe(2);
    expect(paths[0], "the older wire must not move when a new one is added").toBe(firstBefore);
    expect(isOrthogonal(parsePath(paths[1]))).toBe(true);
    void degradedBefore;
  });

  test("undo removes a wire and redo restores it, geometry included", async ({ page }) => {
    await setup(page);
    const before = await wirePaths(page);

    await page.keyboard.press("Control+z");
    await expect(page.locator(".rlc-status")).toContainText("连线 0");
    await expect(page.locator("path.rlc-wire")).toHaveCount(0);

    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    expect(await wirePaths(page)).toEqual(before);
  });

  test("the exported netlist is structurally valid for scikit-rf", async ({ page }) => {
    await setup(page);

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

    // Every wire carries its solved polyline, so the drawing can be restored from the file.
    const wires = netlist.schematic.wires as { waypoints: unknown[] }[];
    expect(wires.length).toBe(1);
    expect(wires.every((w) => w.waypoints.length >= 2)).toBe(true);

    // R/L/C values are SI numbers, and the display text is kept alongside.
    for (const n of netlist.networks as { kind: string; value?: number; value_text?: string }[]) {
      if (["resistor", "inductor", "capacitor"].includes(n.kind)) {
        expect(typeof n.value).toBe("number");
        expect(Number.isFinite(n.value!)).toBe(true);
        expect(typeof n.value_text).toBe("string");
      }
    }
  });

  test("a wire survives a reload with its path unchanged after an edit", async ({ page }) => {
    await setup(page);
    // Move a part so the wire has to re-route, then save that shape.
    const box = await page.locator("g.rlc-symbol").nth(0).boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 150, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const before = await wirePaths(page);

    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await wirePaths(page), "the moved-and-re-routed shape must be replayed").toEqual(before);
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
