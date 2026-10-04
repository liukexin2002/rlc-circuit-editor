/**
 * Post-deployment verification against the LIVE GitHub Pages URL.
 *
 * This is the acceptance test for the delivered link: it drives a real browser against the
 * deployed site — not a local build — and asserts the two headline features on measured
 * geometry (the rendered SVG path vs the model's own record of the obstacle).
 */

import { expect, test, type Page } from "@playwright/test";

const LIVE_URL = "https://liukexin2002.github.io/rlc-circuit-editor/";

async function dragOn(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function pinPoint(page: Page, index: number, pinId: "p0" | "p1") {
  const box = await page.locator(`[data-pin-id="${pinId}"]`).nth(index).boundingBox();
  if (!box) throw new Error(`pin ${pinId} #${index} not found`);
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

async function symbolCentre(page: Page, index: number) {
  const box = await page.locator("g.rlc-symbol").nth(index).boundingBox();
  if (!box) throw new Error(`symbol #${index} not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function wirePoints(page: Page) {
  const d = await page.locator("path.rlc-wire").first().getAttribute("d");
  if (!d) return [];
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

function bodyRectOf(c: { x: number; y: number; rotation: number }) {
  const vertical = c.rotation === 90 || c.rotation === 270;
  const hw = vertical ? 8 : 24;
  const hh = vertical ? 24 : 8;
  return { left: c.x - hw, right: c.x + hw, top: c.y - hh, bottom: c.y + hh };
}

function polylineCrossesRect(
  pts: { x: number; y: number }[],
  r: { left: number; right: number; top: number; bottom: number },
) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (
      Math.min(a.x, b.x) <= r.right &&
      Math.max(a.x, b.x) >= r.left &&
      Math.min(a.y, b.y) <= r.bottom &&
      Math.max(a.y, b.y) >= r.top
    ) {
      return true;
    }
  }
  return false;
}

test.describe("DELIVERED LINK — live GitHub Pages", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(LIVE_URL, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("元件 0");
  });

  test("the deployed page loads and boots the editor", async ({ page }) => {
    await expect(page).toHaveTitle(/RLC/);
    await expect(page.getByText("RLC 电路图编辑器")).toBeVisible();
    await expect(page.locator(".rlc-part")).toHaveCount(3);
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("网格 16px");
  });

  test("place → rotate → connect → verify orthogonal wire on the live site", async ({ page }) => {
    const first = await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");
    await expect(page.locator(".rlc-status")).toContainText("元件 2");

    // Rotate the first part and confirm the property panel agrees.
    await page.mouse.click(first.x, first.y);
    await page.keyboard.press("r");
    await expect(page.locator(".rlc-side select")).toHaveValue("90");

    // Connect across the two parts.
    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");

    const pts = await wirePoints(page);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonal(pts), `live wire must be orthogonal: ${JSON.stringify(pts)}`).toBe(true);
  });

  test("obstacle avoidance works on the live site (measured, not eyeballed)", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电容");

    const p1 = await pinPoint(page, 0, "p1");
    await page.mouse.click(p1.x, p1.y);
    const p0 = await pinPoint(page, 1, "p0");
    await page.mouse.click(p0.x, p0.y);
    await expect(page.locator(".rlc-status")).toContainText("连线 1");

    // Drop a blocker exactly on the straight line between the two pins.
    await placeFromPalette(page, "电感");
    const mid = { x: (p1.x + p0.x) / 2, y: (p1.y + p0.y) / 2 };
    await dragOn(page, await symbolCentre(page, 2), mid);

    const raw = await page.evaluate(() => window.localStorage.getItem("rlc-schematic-doc-v1"));
    expect(raw, "the live editor must autosave").toBeTruthy();
    const doc = JSON.parse(raw!) as {
      components: { kind: string; x: number; y: number; rotation: number }[];
    };
    const blocker = doc.components.find((c) => c.kind === "inductor");
    expect(blocker, "blocker must be in the live document").toBeTruthy();

    const pts = await wirePoints(page);
    expect(isOrthogonal(pts), `live wire must be orthogonal: ${JSON.stringify(pts)}`).toBe(true);
    expect(
      polylineCrossesRect(pts, bodyRectOf(blocker!)),
      `live wire must not cross the blocker: path=${JSON.stringify(pts)} blocker=${JSON.stringify(blocker)}`,
    ).toBe(false);
    await expect(page.locator(".rlc-status")).toContainText("降级连线 0");
  });

  test("undo works on the live site", async ({ page }) => {
    await placeFromPalette(page, "电阻");
    await placeFromPalette(page, "电感");
    await expect(page.locator(".rlc-status")).toContainText("元件 2");
    await page.keyboard.press("Control+z");
    await expect(page.locator(".rlc-status")).toContainText("元件 1");
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator(".rlc-status")).toContainText("元件 2");
  });
});
