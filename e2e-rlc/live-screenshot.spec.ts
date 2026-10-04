/**
 * Capture the delivered link's UI for the delivery record.
 * Run: npx playwright test --config playwright.live.config.ts --grep @screenshot
 */

import { expect, test } from "@playwright/test";

const LIVE_URL = "https://liukexin2002.github.io/rlc-circuit-editor/";

async function placeFromPalette(page: import("@playwright/test").Page, name: string) {
  const before = await page.locator("g.rlc-symbol").count();
  await page.locator(".rlc-part", { hasText: name }).click();
  await expect(page.locator("g.rlc-symbol")).toHaveCount(before + 1);
  const box = await page.locator("g.rlc-symbol").nth(before).boundingBox();
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function symbolCentre(page: import("@playwright/test").Page, index: number) {
  const box = await page.locator("g.rlc-symbol").nth(index).boundingBox();
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function pinPoint(page: import("@playwright/test").Page, index: number, pinId: string) {
  const box = await page.locator(`[data-pin-id="${pinId}"]`).nth(index).boundingBox();
  if (!box) throw new Error("no pin box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("@screenshot decorated editor from the live site", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LIVE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.locator("svg.rlc-canvas")).toBeVisible();

  // A small but representative circuit: two sources, a couple of blockers, four wires.
  await placeFromPalette(page, "电阻");   // R1
  await placeFromPalette(page, "电容");   // C1
  await placeFromPalette(page, "电感");   // L1
  await placeFromPalette(page, "电阻");   // R2

  // R1.p1 → C1.p0
  let a = await pinPoint(page, 0, "p1");
  await page.mouse.click(a.x, a.y);
  let b = await pinPoint(page, 1, "p0");
  await page.mouse.click(b.x, b.y);

  // L1.p1 → R2.p0
  a = await pinPoint(page, 2, "p1");
  await page.mouse.click(a.x, a.y);
  b = await pinPoint(page, 3, "p0");
  await page.mouse.click(b.x, b.y);

  // Rotate R2 upright so a vertical pin shows in the picture.
  const r2 = await symbolCentre(page, 3);
  await page.mouse.click(r2.x, r2.y);
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await page.waitForTimeout(400);

  await page.screenshot({ path: "e2e-rlc/live-editor.png", fullPage: false });
});
