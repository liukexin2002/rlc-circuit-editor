import { test, expect } from "@playwright/test";

/**
 * Smoke test: the real app boots, the canvas mounts, auto-routing runs, and nothing
 * throws to the console (the routing budget toast and fatal errors both surface here).
 * Deliberately does not assert an exact edge count — the editor auto-loads whatever is
 * in storage / the default schematic; the headless harness owns rule verification.
 */
test("app boots and routes the canvas without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  // Skip the first-visit landing page so we land directly in the editor.
  await page.addInitScript(() => localStorage.setItem("easyschematic-skip-landing", "1"));
  await page.goto("/");

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // Allow the routing debounce + A* pass to settle, then snapshot.
  await page.waitForTimeout(1_500);
  const edgeCount = await page.locator(".react-flow__edge").count();
  console.log(`canvas rendered with ${edgeCount} edge(s)`);

  await page.screenshot({ path: "e2e/screenshots/canvas.png" });

  // Ignore known-benign noise unrelated to routing correctness. The 401/403 resource
  // errors are the logged-out session/cloud checks (/auth/me etc.) firing when a local
  // API happens to be reachable — orthogonal to routing, and absent in CI where no API runs.
  const meaningful = errors.filter(
    (e) =>
      !/favicon|ResizeObserver loop|service worker|Manifest/i.test(e) &&
      !/Failed to load resource.*status of (401|403)/i.test(e),
  );
  expect(meaningful, `console errors:\n${meaningful.join("\n")}`).toHaveLength(0);
});
