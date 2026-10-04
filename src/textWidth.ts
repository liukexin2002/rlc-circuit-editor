/**
 * Deterministic width estimate for canvas label text.
 *
 * Deliberately NOT canvas `measureText`: the same estimate has to come out
 * identical in the browser, in jsdom under vitest, and in the plain-Node routing
 * harness (`npm run routing:check` compares byte-for-byte). A DOM measurement
 * would make device geometry depend on which of those measured it.
 *
 * The tables are real horizontal advance widths read out of the Inter faces this
 * app ships (`public/fonts/Inter-Regular.ttf`, `public/fonts/Inter-Bold.ttf`),
 * normalized against the 2048-unit em. Only those two weights are declared in
 * `@font-face`, so CSS weight matching resolves `font-semibold` (600) to Bold —
 * hence "bold", not "semibold", for the device header label.
 *
 * The remaining inaccuracy is kerning and any glyph outside the table (both
 * ignored), so read the result as ±3% rather than exact.
 */

export type LabelWeight = "regular" | "bold";

/** Inter Regular (400) advance widths, em fractions. */
const REGULAR: Record<string, number> = {
  " ": 0.281, "!": 0.288, "\"": 0.466, "#": 0.633, "$": 0.642, "%": 0.982,
  "&": 0.644, "'": 0.300, "(": 0.365, ")": 0.365, "*": 0.501, "+": 0.662,
  ",": 0.288, "-": 0.460, ".": 0.288, "/": 0.360, "0": 0.631, "1": 0.407,
  "2": 0.610, "3": 0.618, "4": 0.646, "5": 0.593, "6": 0.620, "7": 0.566,
  "8": 0.619, "9": 0.620, ":": 0.288, ";": 0.302, "<": 0.662, "=": 0.662,
  ">": 0.662, "?": 0.511, "@": 0.966, "A": 0.690, "B": 0.654, "C": 0.730,
  "D": 0.722, "E": 0.601, "F": 0.590, "G": 0.746, "H": 0.743, "I": 0.269,
  "J": 0.571, "K": 0.672, "L": 0.565, "M": 0.903, "N": 0.753, "O": 0.765,
  "P": 0.639, "Q": 0.765, "R": 0.644, "S": 0.642, "T": 0.646, "U": 0.744,
  "V": 0.690, "W": 0.985, "X": 0.682, "Y": 0.679, "Z": 0.629, "[": 0.365,
  "\\": 0.360, "]": 0.365, "^": 0.471, "_": 0.456, "`": 0.323, "a": 0.562,
  "b": 0.612, "c": 0.571, "d": 0.612, "e": 0.583, "f": 0.370, "g": 0.613,
  "h": 0.591, "i": 0.242, "j": 0.242, "k": 0.549, "l": 0.242, "m": 0.876,
  "n": 0.591, "o": 0.600, "p": 0.612, "q": 0.612, "r": 0.376, "s": 0.528,
  "t": 0.327, "u": 0.591, "v": 0.562, "w": 0.818, "x": 0.546, "y": 0.562,
  "z": 0.552, "{": 0.426, "|": 0.333, "}": 0.426, "~": 0.662, "–": 0.500,
  "—": 1.000, "‘": 0.261, "’": 0.261, "“": 0.440, "”": 0.440, "°": 0.456,
  "×": 0.662, "→": 0.954, "←": 0.954, "↑": 0.834, "↓": 0.834, "↔": 1.341,
  "⇔": 1.341,
};

/** Inter Bold (700) advance widths, em fractions. Also what `font-semibold` renders as. */
const BOLD: Record<string, number> = {
  " ": 0.237, "!": 0.338, "\"": 0.552, "#": 0.649, "$": 0.655, "%": 1.016,
  "&": 0.672, "'": 0.339, "(": 0.377, ")": 0.377, "*": 0.559, "+": 0.679,
  ",": 0.334, "-": 0.468, ".": 0.334, "/": 0.388, "0": 0.674, "1": 0.431,
  "2": 0.630, "3": 0.646, "4": 0.676, "5": 0.622, "6": 0.649, "7": 0.582,
  "8": 0.651, "9": 0.649, ":": 0.334, ";": 0.343, "<": 0.679, "=": 0.679,
  ">": 0.679, "?": 0.560, "@": 1.016, "A": 0.747, "B": 0.662, "C": 0.740,
  "D": 0.722, "E": 0.607, "F": 0.587, "G": 0.750, "H": 0.747, "I": 0.281,
  "J": 0.584, "K": 0.719, "L": 0.565, "M": 0.932, "N": 0.762, "O": 0.771,
  "P": 0.648, "Q": 0.777, "R": 0.657, "S": 0.655, "T": 0.667, "U": 0.732,
  "V": 0.747, "W": 1.038, "X": 0.738, "Y": 0.731, "Z": 0.664, "[": 0.377,
  "\\": 0.388, "]": 0.377, "^": 0.487, "_": 0.476, "`": 0.365, "a": 0.581,
  "b": 0.630, "c": 0.588, "d": 0.630, "e": 0.596, "f": 0.398, "g": 0.632,
  "h": 0.623, "i": 0.271, "j": 0.271, "k": 0.580, "l": 0.271, "m": 0.913,
  "n": 0.623, "o": 0.613, "p": 0.630, "q": 0.630, "r": 0.407, "s": 0.560,
  "t": 0.366, "u": 0.623, "v": 0.600, "w": 0.850, "x": 0.580, "y": 0.602,
  "z": 0.573, "{": 0.469, "|": 0.372, "}": 0.469, "~": 0.679, "–": 0.500,
  "—": 1.000, "‘": 0.311, "’": 0.311, "“": 0.540, "”": 0.532, "°": 0.459,
  "×": 0.679, "→": 0.954, "←": 0.954, "↑": 0.905, "↓": 0.905, "↔": 1.341,
  "⇔": 1.341,
};

/** Table average — what an unlisted glyph (accented, CJK-adjacent, emoji) costs. */
const FALLBACK_RATIO: Record<LabelWeight, number> = { regular: 0.584, bold: 0.61 };

/** Estimated rendered width, in px, of `text` at `fontSizePx`. */
export function estimateTextWidthPx(
  text: string,
  fontSizePx: number,
  weight: LabelWeight = "regular",
): number {
  if (!text) return 0;
  const table = weight === "bold" ? BOLD : REGULAR;
  const fallback = FALLBACK_RATIO[weight];
  let ems = 0;
  for (const ch of text) ems += table[ch] ?? fallback;
  return ems * fontSizePx;
}
