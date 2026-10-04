// The one canonical handle→port rule. A device's handle ids are usually just its port
// ids, but bidirectional ports own "<id>-in"/"<id>-out" and passthrough ports own
// "<id>-rear"/"<id>-front", so a handle sometimes has to be stripped back to the port.
//
// The trap this module exists to close (#355): plenty of REAL port ids end in one of
// those same tokens — the seeded fixture alone ships "mon-hdmi-in", "spk-iec-in" and
// "laptop-hdmi-out" — so stripping unconditionally asked for a port id that does not
// exist. Callers then printed the raw handle id on stub tags, DXF and PDF pills, left
// patch-panel rows blank, or under-counted a PoE budget. Always match the handle
// exactly first, and only strip when that exact match fails.
//
// Kept free of any store/label dependency so pure report and validation modules can
// use it without pulling the app state in.

import type { DeviceData, Port } from "./types";

const FACE_SUFFIX = /-(in|out|rear|front)$/;

/**
 * The underlying port id for a handle that carries a face suffix, or undefined when
 * the handle has no suffix to strip (in which case an exact match is the only match).
 */
export function strippedHandleId(handleId: string): string | undefined {
  const base = handleId.replace(FACE_SUFFIX, "");
  return base === handleId ? undefined : base;
}

/** Find the port a handle id refers to: exact id first, suffix-stripped id as fallback. */
export function findPortByHandle(data: DeviceData, handleId: string): Port | undefined {
  const exact = data.ports.find((p) => p.id === handleId);
  if (exact) return exact;
  const base = strippedHandleId(handleId);
  return base === undefined ? undefined : data.ports.find((p) => p.id === base);
}
