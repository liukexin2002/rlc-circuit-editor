/**
 * RLC editor constants.
 *
 * The routing grid (CELL_SIZE) must equal GRID: the model places every pin exactly on
 * the lattice and the router converts pixels to cells by rounding, so a mismatch shows
 * up as a one-cell jog at every endpoint. GRID_SIZE=16 mirrors the upstream editor's
 * lattice so the shared pathfinding code keeps its calibrated assumptions
 * (STUB=1 cell, PAD=1 cell, ESCAPE_MARGIN=2 cells).
 */

/** Canvas snap grid and routing cell size, in pixels. */
export const GRID = 16;

/** Document schema version this build writes. v2 added stored geometry (+ ports/grounds). */
export const DOC_VERSION = 2;

/** Editor version shown in the toolbar and stamped into exported netlists. */
export const EDITOR_VERSION = "2.1.0";

/**
 * Routing-model version stamp written into exported files. A file whose stamp differs was
 * produced by different routing rules, so a re-route may legitimately differ; the loader
 * records that instead of pretending the geometry is reproducible.
 */
export const ROUTING_MODEL = "orthogonal-a-star/2";

/**
 * Click tolerance for selecting a wire, in SCREEN pixels. Converted to world units by dividing
 * by the current zoom, so grabbing a wire feels the same at every scale.
 */
export const WIRE_HIT_PX = 8;

/** Distance between the two pin centers of one component (4 cells). */
export const SYMBOL_SPAN = 4 * GRID;

/** Symbol body thickness. */
export const SYMBOL_BODY_H = GRID;

/** Length of the lead stub from the body edge to the pin. */
export const PIN_STUB = GRID;

/**
 * Obstacle padding around a component body, in pixels (1 cell).
 *
 * Calibrated against the upstream editor's routing engine, which uses PAD=1 cell and
 * STUB=1 cell: a pin sits exactly one cell outside its own body, so the pad boundary and
 * the pin coincide and a one-cell stub lands clear of the pad. A larger pad would push the
 * stub past the pin into the neighbouring part whenever two parts sit close together.
 */
export const OBSTACLE_PAD = GRID;

/**
 * Comfort padding used by the STRICTEST routing tier (2 cells). A wire routed at this
 * clearance has a visibly generous gap around every part.
 */
export const COMFORT_PAD = 2 * GRID;

/** Corner rounding of the rendered wire path, in pixels. */
export const WIRE_CORNER_RADIUS = 8;

/**
 * Stub length: every wire runs one full cell straight out of a pin before it may turn.
 * One cell is also the only value that works at every legal spacing, because two pins
 * facing each other can be as close as two cells.
 */
export const STUB_CELLS = 1;
export const STUB_PX = STUB_CELLS * GRID;

/**
 * Hard invariant for every routed wire: at least one full cell of straight travel at each
 * end, along the pin's facing. One cell is the minimum that is always geometrically
 * achievable (two pins facing each other one cell apart cannot give more); the design
 * length above is what the common case delivers.
 */
export const MIN_STUB_PX = GRID;

/** Monotonic work budget for one full-document routing pass (A* expansions). */
export const ROUTE_OPS_BUDGET = 200_000;

/** Undo stack depth. */
export const HISTORY_LIMIT = 100;

/** localStorage key for the autosaved document. */
export const LS_KEY = "rlc-schematic-doc-v1";
