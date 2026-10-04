/** Grid size in px — must match snapGrid in App.tsx and Background gap.
 *  Lives in its own module so utility files (snapUtils, etc.) can import it
 *  without pulling in the full store, which would create a circular import
 *  the moment the store wants to call back into those utilities.
 *
 *  16 since schema v41 (was 20). Port row pitch, header-band rounding, and the
 *  routing CELL_SIZE all derive from this; saved files from the 20px era are
 *  rescaled x0.8 on load (exact: every 20-multiple maps onto a 16-multiple).
 *  16 is the floor — cable-ID badges are ~13px tall and stack at port pitch. */
export const GRID_SIZE = 16;
