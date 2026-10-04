/**
 * Capture the delivered v2 link's UI, including a tapped circuit, for the delivery record.
 * Run: npx playwright test --config playwright.live.config.ts --grep @screenshot-v2
 */

import { expect, test, type Page } from "@playwright/test";

const LIVE_URL = process.env.RLC_LIVE_URL ?? "https://liukexin2002.github.io/rlc-circuit-editor/";

async function place(page: Page, name: string) {
  const before = await page.locator("g.rlc-symbol").count();
  await page.locator(".rlc-part", { hasText: name }).click();
  await expect(page.locator("g.rlc-symbol")).toHaveCount(before + 1);
}

async function pin(page: Page, i: number, id: "p0" | "p1") {
  const b = await page.locator(`[data-pin-id="${id}"]`).nth(i).boundingBox();
  if (!b) throw new Error("no pin");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function symbolCentre(page: Page, i: number) {
  const b = await page.locator("g.rlc-symbol").nth(i).boundingBox();
  if (!b) throw new Error("no symbol");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function dragPart(page: Page, i: number, dx: number, dy: number) {
  const c = await symbolCentre(page, i);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 8 });
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 8 });
  await page.mouse.up();
}

async function onWire(page: Page, which = 0) {
  const d = await page.locator("path.rlc-wire-hit").nth(which).getAttribute("d");
  const pts = [...(d ?? "").matchAll(/[MLQ]\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
  let best = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  let longest = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    if (len > longest) {
      longest = len;
      best = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
    }
  }
  const s = await page.evaluate((w) => {
    const g = document.querySelector('[data-testid="rlc-viewport"]') as SVGGElement | null;
    const ctm = g?.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(w.x, w.y).matrixTransform(ctm);
    return { x: pt.x, y: pt.y };
  }, best);
  if (!s) throw new Error("no mapping");
  return s;
}

test("@screenshot-v2 tapped circuit on the live site", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LIVE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.locator("svg.rlc-canvas")).toBeVisible();

  // A trunk between two parts, with a shunt part tapped onto it: the v2 feature.
  await place(page, "电阻"); // R1
  await place(page, "电容"); // C1  (will be moved below and tapped)
  await place(page, "电感"); // L1

  // Separate them: palette slots are only ~8 cells apart, which leaves no room for a wire.
  await dragPart(page, 0, -180, 0);
  await dragPart(page, 1, 0, 210);
  await dragPart(page, 2, 200, 0);
  await page.waitForTimeout(150);

  const p1 = await pin(page, 0, "p1");
  await page.mouse.click(p1.x, p1.y);
  const p0 = await pin(page, 2, "p0");
  await page.mouse.click(p0.x, p0.y);
  await expect(page.locator(".rlc-status")).toContainText("连线 1");

  // Rotate the capacitor upright, then tap the trunk with its top pin.
  await page.mouse.click((await symbolCentre(page, 1)).x, (await symbolCentre(page, 1)).y);
  await page.keyboard.press("r");
  await page.waitForTimeout(150);

  const from = await pin(page, 1, "p0");
  await page.mouse.click(from.x, from.y);
  const wire = await onWire(page, 0);
  await page.mouse.move(wire.x, wire.y);
  await page.waitForTimeout(250);
  // Capture the HOVER state, so the highlight and the junction preview are visible.
  await page.screenshot({ path: "e2e-rlc/live-v2-tap-hover.png" });
  await page.mouse.click(wire.x, wire.y);
  await page.waitForTimeout(300);

  await expect(page.locator(".rlc-status")).toContainText("结点 1");
  await page.screenshot({ path: "e2e-rlc/live-v2-tapped.png" });
});
