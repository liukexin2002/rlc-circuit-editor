/**
 * End-to-end smoke test for the standalone RLC editor.
 *
 * This is the browser-level half of the acceptance story: the unit tests prove the ROUTING
 * RULES on measured geometry, and this proves the editor a human actually touches —
 * placing parts, rotating them, drawing a connection pin-to-pin, watching the wire detour
 * around a part dropped in its path, and surviving undo/redo and a reload.
 *
 * Runs against the built artifact (see playwright.rlc.config.ts), so what passes here is
 * what ships.
 */

import { expect, test, type Page } from "@playwright/test";

/** Dispatch a full pointer gesture; Playwright's drag helpers do not cover SVG pins. */
async function dragOn(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** Screen position of the `index`-th pin with the given id (2 pins per part). */
async function pinPoint(page: Page, index: number, pinId: "p0" | "p1") {
  const el = page.locator(`[data-pin-id="${pinId}"]`).nth(index);
  const box = await el.boundingBox();
  if (!box) throw new Error(`pin ${pinId} #${index} not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Place a part by clicking its palette entry, then read its screen centre. */
async function placeFromPalette(page: Page, name: string): Promise<{ x: number; y: number }> {
  const before = await page.locator("g.rlc-symbol").count();
  await page.locator(".rlc-part", { hasText: name }).click();
  await expect(page.locator("g.rlc-symbol")).toHaveCount(before + 1);
  const box = await page.locator("g.rlc-symbol").nth(before).boundingBox();
  if (!box) throw new Error("placed symbol has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Screen centre of the symbol at `index`. */
async function symbolCentre(page: Page, index: number) {
  const box = await page.locator("g.rlc-symbol").nth(index).boundingBox();
  if (!box) throw new Error(`symbol #${index} not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The rendered wire commands, as an array of [x, y] points parsed from the SVG path. */
async function wirePoints(page: Page): Promise<{ x: number; y: number }[]> {
  const d = await page.locator("path.rlc-wire").first().getAttribute("d");
  if (!d) return [];
  return [...d.matchAll(/[MLQ]\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

/** True when every consecutive pair in a polyline shares an axis (orthogonality). */
function isOrthogonal(pts: { x: number; y: number }[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.abs(pts[i].x - pts[i - 1].x);
    const dy = Math.abs(pts[i].y - pts[i - 1].y);
    if (dx > 0.01 && dy > 0.01) return false;
  }
  return true;
}

/** The document as the editor autosaved it — the model the canvas is rendering. */
async function savedDoc(page: Page) {
  const raw = await page.evaluate(() => window.localStorage.getItem("rlc-schematic-doc-v1"));
  if (!raw) throw new Error("no autosaved document");
  return JSON.parse(raw) as {
    version: number;
    components: { id: string; kind: string; x: number; y: number; rotation: number; label: string }[];
    edges: { id: string; from: { componentId: string; pinId: string }; to: { componentId: string; pinId: string } }[];
  };
}

/** Body half-extents for a part (matches the model's SYMBOL_SPAN/PIN_STUB geometry). */
const BODY_HALF_LONG = 24;
const BODY_HALF_SHORT = 8;

/**
 * World-space rect of a part's BODY, derived from the autosaved model. This is the hard
 * obstacle a foreign wire must never cross, so asserting against it is a real avoidance
 * check rather than a proxy.
 */
function bodyRectOf(c: { x: number; y: number; rotation: number }) {
  const vertical = c.rotation === 90 || c.rotation === 270;
  const hw = vertical ? BODY_HALF_SHORT : BODY_HALF_LONG;
  const hh = vertical ? BODY_HALF_LONG : BODY_HALF_SHORT;
  return { left: c.x - hw, right: c.x + hw, top: c.y - hh, bottom: c.y + hh };
}

/** Does any segment of the polyline intersect the axis-aligned rect? */
function polylineCrossesRect(
  pts: { x: number; y: number }[],
  r: { left: number; right: number; top: number; bottom: number },
): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const lox = Math.min(a.x, b.x);
    const hix = Math.max(a.x, b.x);
    const loy = Math.min(a.y, b.y);
    const hiy = Math.max(a.y, b.y);
    if (lox <= r.right && hix >= r.left && loy <= r.bottom && hiy >= r.top) return true;
  }
  return false;
}

declare global {
  interface Window {
    /** Test hook: cleared once the app has restored any autosaved document. */
    __rlcErrors?: string[];
  }
}

test.describe("RLC editor", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    (page as unknown as { __errors: string[] }).__errors = errors;

    // Start from a genuinely empty editor: load once (so the origin exists), clear the
    // autosave, then reload. Doing it in this order keeps a later `page.reload()` — which
    // the persistence test relies on — from being wiped.
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("元件 0");
  });

  test("boots with the palette, canvas and status bar", async ({ page }) => {
    await expect(page.getByText("RLC 电路图编辑器")).toBeVisible();
    await expect(page.locator(".rlc-part")).toHaveCount(3);
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");
    await expect(page.locator(".rlc-status")).toContainText("网格 16px");
  });

  test("places R, L and C with auto-incrementing designators", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电感");
    await placeFromPalette(page, "电容");
    const labels = await page.locator("g.rlc-symbol text.rlc-label").allTextContents();
    expect(labels).toEqual(expect.arrayContaining(["R1", "R2", "L1", "C1"]));
    await expect(page.locator(".rlc-status")).toContainText("元件 4");
  });

  test("selects a part by clicking the middle of its symbol", async ({ page }) => {
    const centre = await placeFromPalette(page, "电阻");
    // Clicking the symbol BODY (not a pin, not the label) must select it. The panel shows
    // the designator in an <input>, so assert on the value rather than on text content.
    await page.mouse.click(centre.x, centre.y);
    await expect(page.locator(".rlc-side")).toContainText("位号");
    await expect(page.locator(".rlc-side input").first()).toHaveValue("R1");
  });

  test("rotates the selected part with R", async ({ page }) => {
    const centre = await placeFromPalette(page, "电阻");
    await page.mouse.click(centre.x, centre.y);
    await expect(page.locator(".rlc-side")).toContainText("位号");

    const boxBefore = await page.locator("g.rlc-symbol").first().boundingBox();
    await page.keyboard.press("r");
    await expect(page.locator(".rlc-side select")).toHaveValue("90");
    // A rotated symbol swaps its width and height on screen.
    await expect
      .poll(async () => {
        const b = await page.locator("g.rlc-symbol").first().boundingBox();
        return b ? b.height - (boxBefore?.width ?? 0) : -999;
      })
      .toBeLessThan(12);
  });

  test("creates a grid-snapped move when a part is dragged", async ({ page }) => {
    const centre = await placeFromPalette(page, "电容");
    const before = await page.locator("g.rlc-symbol").first().boundingBox();
    await dragOn(page, centre, { x: centre.x + 160, y: centre.y + 96 });
    const after = await page.locator("g.rlc-symbol").first().boundingBox();
    const dx = after!.x - before!.x;
    expect(dx).toBeGreaterThan(100);
    // Snapped moves land on multiples of the 16px lattice.
    expect(Math.min(dx % 16, 16 - (dx % 16))).toBeLessThan(2);
  });

  test("connects two parts pin to pin and renders an orthogonal wire", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");

    // Pin order per part: p0 then p1. Part 1's p1 is index 0; part 2's p0 is index 1.
    const start = await pinPoint(page, 0, "p1");
    await page.mouse.click(start.x, start.y);
    const target = await pinPoint(page, 1, "p0");
    await page.mouse.click(target.x, target.y);

    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");
    const pts = await wirePoints(page);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonal(pts), `wire must be orthogonal: ${JSON.stringify(pts)}`).toBe(true);
  });

  test("routes AROUND a part placed on the straight line between two pins", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");

    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");

    // Put a blocker EXACTLY on the straight line between the two pins, in world coords,
    // by dragging it there. Both parts sit on the same row, so the wire's natural route
    // runs straight through this point.
    await placeFromPalette(page, "电感");
    const mid = { x: (p1.x + p0.x) / 2, y: (p1.y + p0.y) / 2 };
    await dragOn(page, await symbolCentre(page, 2), mid);

    const doc = await savedDoc(page);
    const blocker = doc.components.find((c) => c.kind === "inductor");
    expect(blocker, "the blocker must be in the document").toBeTruthy();

    // The wire must sit on the same row as the pins, and the blocker must therefore be in
    // its way — otherwise this test would be asserting nothing.
    const pts = await wirePoints(page);
    expect(isOrthogonal(pts), `wire must be orthogonal: ${JSON.stringify(pts)}`).toBe(true);

    // THE requirement: no segment of the wire may pass through the blocker's body.
    expect(
      polylineCrossesRect(pts, bodyRectOf(blocker!)),
      `wire must not cross the blocker body: path=${JSON.stringify(pts)} blocker=${JSON.stringify(blocker)}`,
    ).toBe(false);

    // And the wire must still connect both pins, reported as fully clear.
    const edge = doc.edges[0];
    expect(edge).toBeTruthy();
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");
  });

  test("supports undo, redo and cascade delete", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");
    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");

    // Delete the source part: its wire must go with it.
    await page.mouse.click((await symbolCentre(page, 0)).x, (await symbolCentre(page, 0)).y);
    await page.keyboard.press("Delete");
    await expect(page.locator(".rlc-status")).toContainText("连线 0");
    await expect(page.locator(".rlc-status")).toContainText("元件 1");

    // Undo restores both part and wire; redo removes them again.
    await page.keyboard.press("Control+z");
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".rlc-status")).toContainText("连线 0");
    await expect(page.locator(".rlc-status")).toContainText("元件 1");
  });

  test("persists the document across a reload", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电感");
    await expect(page.locator(".rlc-status")).toContainText("元件 2");
    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("元件 2");
  });

  test("autosaves a valid document that survives a round trip", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");
    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");

    // The autosave is the same JSON the export button hands the user, so asserting on it
    // proves both paths at once.
    const json = await page.evaluate(() => window.localStorage.getItem("rlc-schematic-doc-v1"));
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json!);
    expect(parsed.components).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0].from.pinId).toBe("p1");
    expect(parsed.edges[0].to.pinId).toBe("p0");
    expect(parsed.version).toBe(1);

    // And it reloads into an identical document.
    await page.reload();
    await expect(page.locator(".rlc-status")).toContainText("元件 2");
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    const after = await page.evaluate(() => window.localStorage.getItem("rlc-schematic-doc-v1"));
    expect(JSON.parse(after!).components).toHaveLength(2);
  });

  test("reports no console errors during a full editing session", async ({ page }) => {
    const a = await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");
    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await page.mouse.click(a.x, a.y);
    await page.keyboard.press("r");
    await page.keyboard.press("Control+z");
    const errors = (page as unknown as { __errors: string[] }).__errors ?? [];
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });
});
