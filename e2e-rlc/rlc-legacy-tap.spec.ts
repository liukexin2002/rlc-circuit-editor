/**
 * The retired tap document: what a user sees when they load one.
 *
 * The tap-enabled build wrote wire endpoints of the shape `{kind:"tap", edgeId, x, y}`.
 * This build cannot reproduce those ties, so the honest behaviour is to REFUSE the file with
 * a message that names the cause — never to drop the endpoints and show a silently different
 * drawing. This test drives that behaviour in a real browser, so the claim in DELIVERY.md is
 * verified rather than asserted.
 */

import { expect, test } from "@playwright/test";

/** A minimal v2.0-era document with one tap endpoint, as that build wrote it. */
function tapDocument() {
  return {
    version: 2,
    components: [
      { id: "c1", kind: "resistor", x: 320, y: 320, rotation: 0, label: "R1", value: "10k" },
      { id: "c2", kind: "capacitor", x: 960, y: 320, rotation: 0, label: "C1", value: "100nF" },
      { id: "c3", kind: "inductor", x: 640, y: 700, rotation: 270, label: "L1", value: "100uH" },
    ],
    edges: [
      { id: "e1", from: { kind: "pin", componentId: "c1", pinId: "p1" },
        to: { kind: "pin", componentId: "c2", pinId: "p0" } },
      // The retired shape: a wire ending on ANOTHER WIRE.
      { id: "e2", from: { kind: "pin", componentId: "c3", pinId: "p1" },
        to: { kind: "tap", edgeId: "e1", x: 640, y: 320 } },
    ],
    geometry: {
      e1: { waypoints: [{ x: 352, y: 320 }, { x: 928, y: 320 }], quality: "clean" },
      e2: { waypoints: [{ x: 640, y: 668 }, { x: 640, y: 320 }], quality: "clean" },
    },
    ports: [],
    grounds: [],
    avoidWires: true,
    nextEdgeSeq: 3,
    labelSeq: { resistor: 1, inductor: 1, capacitor: 1 },
  };
}

test.describe("legacy tap document — refused with a reason, not silently redrawn", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();
    await expect(page.locator(".rlc-status")).toContainText("元件 0");
  });

  test("importing a tap document reports the retired endpoint instead of loading it", async ({ page }) => {
    await page.setInputFiles('input[type="file"]', {
      name: "legacy-tap.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(tapDocument()), "utf8"),
    });

    // The reason must name the retired shape, so a user knows why the file did not open.
    await expect(page.locator(".rlc-toast")).toContainText("接点");
    // And the canvas must be UNCHANGED: nothing was loaded, nothing was redrawn.
    await expect(page.locator(".rlc-status")).toContainText("元件 0");
    await expect(page.locator(".rlc-status")).toContainText("连线 0");
    await expect(page.locator("g.rlc-symbol")).toHaveCount(0);
    await expect(page.locator("path.rlc-wire")).toHaveCount(0);
  });

  test("a tap document in autosave is reported and its bytes are kept, not lost", async ({ page }) => {
    // A user who used the tap build has such a document in localStorage already. The editor
    // must come up cleanly, TELL them why the drawing is gone, and keep the original bytes
    // recoverable — losing work without a word is the one outcome they cannot act on.
    await page.evaluate((doc) => {
      window.localStorage.setItem("rlc-schematic-doc-v1", JSON.stringify(doc));
    }, tapDocument());

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.reload();
    await expect(page.locator("svg.rlc-canvas")).toBeVisible();

    // Not silently loaded: no symbols from the file, no page errors.
    await expect(page.locator("g.rlc-symbol")).toHaveCount(0);
    expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);

    // The reason is on screen and names the retired shape.
    const banner = page.getByTestId("rlc-hydration-notice");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("接点");
    await expect(banner).toContainText("备份");

    // The original bytes survive under the backup key, so the drawing is recoverable by hand.
    const backup = await page.evaluate(() =>
      window.localStorage.getItem("rlc-schematic-doc-backup"),
    );
    expect(backup, "the unreadable autosave must be backed up").toBeTruthy();
    const parsed = JSON.parse(backup!);
    expect(parsed.edges).toHaveLength(2);

    // Dismissing works, and the editor is fully usable afterwards.
    await banner.getByRole("button").click();
    await expect(banner).toHaveCount(0);
    await page.locator(".rlc-part", { hasText: "电阻" }).click();
    await expect(page.locator("g.rlc-symbol")).toHaveCount(1);
  });
});
