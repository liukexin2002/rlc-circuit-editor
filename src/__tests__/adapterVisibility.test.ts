/**
 * Hide/Show Adapter appears on both the device's own context menu (#312) and the
 * connection context menu it originated on. Both call into this shared helper so the
 * "is this adapter currently hidden" read, and the flip that follows it, can't drift
 * between the two menus.
 */
import { describe, it, expect } from "vitest";
import { isAdapterHidden, toggleAdapterVisibility } from "../adapterVisibility";

describe("isAdapterHidden", () => {
  it("reads 'default' as hidden when the global hide-adapters toggle is on", () => {
    expect(isAdapterHidden("default", true)).toBe(true);
    expect(isAdapterHidden(undefined, true)).toBe(true);
  });

  it("reads 'default' as shown when the global toggle is off", () => {
    expect(isAdapterHidden("default", false)).toBe(false);
    expect(isAdapterHidden(undefined, false)).toBe(false);
  });

  it("force-hide is hidden regardless of the global toggle", () => {
    expect(isAdapterHidden("force-hide", false)).toBe(true);
    expect(isAdapterHidden("force-hide", true)).toBe(true);
  });

  it("force-show is shown regardless of the global toggle", () => {
    expect(isAdapterHidden("force-show", false)).toBe(false);
    expect(isAdapterHidden("force-show", true)).toBe(false);
  });
});

describe("toggleAdapterVisibility", () => {
  it("flips a default adapter to force-show when the global toggle reads it as hidden", () => {
    expect(toggleAdapterVisibility("default", true)).toBe("force-show");
    expect(toggleAdapterVisibility(undefined, true)).toBe("force-show");
  });

  it("flips a default adapter to force-hide when the global toggle is off", () => {
    expect(toggleAdapterVisibility("default", false)).toBe("force-hide");
  });

  it("flips force-hide back to force-show", () => {
    expect(toggleAdapterVisibility("force-hide", false)).toBe("force-show");
  });

  it("flips force-show back to force-hide", () => {
    expect(toggleAdapterVisibility("force-show", true)).toBe("force-hide");
  });
});
