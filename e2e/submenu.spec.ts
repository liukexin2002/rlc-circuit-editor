import { test, expect } from "@playwright/test";

// #177 repro: right-click a connection → hover "Line Style" → the flyout submenu
// must stay open while the mouse travels into it. Uses stepped mouse movement
// (not Playwright's teleport hover) so a hover-gap close would actually fire.
test("#177 line-style submenu stays open when moused into", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("easyschematic-skip-landing", "1"));
  await page.goto("/");
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".react-flow__edge").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);

  // Fit the (large default) schematic into view so an edge is actually on-screen.
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(600);

  // Compute an exact on-path, on-screen point (midpoint of an edge) and right-click it.
  const pt = await page.evaluate(() => {
    const paths = [...document.querySelectorAll(".react-flow__edge-interaction")] as unknown as SVGPathElement[];
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const p of paths) {
      const len = p.getTotalLength();
      if (!len) continue;
      const ctm = p.getScreenCTM();
      if (!ctm) continue;
      for (const frac of [0.5, 0.25, 0.75]) {
        const local = p.getPointAtLength(len * frac);
        const sp = new DOMPoint(local.x, local.y).matrixTransform(ctm);
        if (sp.x > 30 && sp.x < vw - 30 && sp.y > 80 && sp.y < vh - 30) return { x: sp.x, y: sp.y };
      }
    }
    return null;
  });
  if (!pt) throw new Error("no on-screen edge found");
  await page.mouse.click(pt.x, pt.y, { button: "right" });

  const trigger = page.getByRole("button", { name: /Line Style:/ });
  await expect(trigger).toBeVisible({ timeout: 5_000 });

  // Hover the trigger via real cursor position.
  const tb = await trigger.boundingBox();
  if (!tb) throw new Error("no trigger bbox");
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);

  const dashed = page.getByRole("button", { name: "Dashed", exact: true });
  await expect(dashed).toBeVisible({ timeout: 3_000 });

  // Travel into the submenu item in small steps (the real-mouse motion that closes it).
  const db = await dashed.boundingBox();
  if (!db) throw new Error("no submenu bbox");
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 15 });
  await page.waitForTimeout(200);

  // The submenu must still be open and the item clickable.
  await expect(dashed, "submenu should stay open while moused into (#177)").toBeVisible();
  await dashed.click();
  await expect(trigger).toBeHidden({ timeout: 2_000 });
});
