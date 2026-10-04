/**
 * Build the slot blueprints for a bulk add — `${prefix} ${start}` … `${prefix} ${start + count - 1}`,
 * all sharing one slot family. Pure: the store assigns slot IDs when it inserts them.
 */
export function buildBulkSlots(
  prefix: string,
  start: number,
  count: number,
  slotFamily: string,
): { label: string; slotFamily: string }[] {
  const slots: { label: string; slotFamily: string }[] = [];
  for (let i = 0; i < count; i++) {
    slots.push({ label: `${prefix} ${start + i}`, slotFamily });
  }
  return slots;
}
