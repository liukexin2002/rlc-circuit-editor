/**
 * Automatic black/white text selection for user-chosen background colors.
 *
 * Device header colors and annotation shape fills are picked by the user, so any
 * fixed text color eventually lands on a background it can't be read against — a
 * black header swallowed the near-black device name (#295), and the 10%-alpha
 * default annotation fill left dark-gray label text invisible on the dark-mode
 * canvas (#258).
 *
 * The rule here is purely automatic (no preference, no picker): composite the
 * background over its backdrop if it's translucent, take the WCAG relative
 * luminance, and return whichever of black / white has the higher contrast ratio
 * against it.
 *
 * Accepts the color formats this codebase actually stores or renders:
 * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`, `rgb()` / `rgba()` in either comma
 * or space syntax, a handful of CSS keywords, and `var(--color-*)` tokens (looked
 * up against the document element, falling back to the var()'s own fallback).
 */

export interface Rgba {
  /** 0-255 */
  r: number;
  /** 0-255 */
  g: number;
  /** 0-255 */
  b: number;
  /** 0-1 */
  a: number;
}

export const CONTRAST_BLACK = "#000000";
export const CONTRAST_WHITE = "#ffffff";

export interface ContrastOptions {
  /** What sits behind a translucent background — the canvas color for annotation
   *  fills. Defaults to white. Ignored when the background is fully opaque. */
  backdrop?: string;
  /** Returned when the background can't be parsed at all. Defaults to black. */
  fallback?: string;
  /** Override the `var(--token)` lookup (tests, or a non-document context). */
  resolveVar?: (name: string) => string;
}

/** The few CSS keywords that plausibly reach these call sites. Anything else
 *  parses as null and falls back rather than pulling in the full 148-name table. */
const NAMED_COLORS: Record<string, string> = {
  transparent: "#00000000",
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
};

const VAR_RE = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]+))?\)$/i;
const RGB_RE = /^rgba?\(([^)]*)\)$/i;

/** Read a CSS custom property off <html>. Returns "" outside a DOM (Node harnesses,
 *  vitest without jsdom), which makes the caller use the var()'s fallback. */
function documentVarLookup(name: string): string {
  if (typeof document === "undefined" || !document.documentElement) return "";
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, n));
}

function parseHex(hex: string): Rgba | null {
  const h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const expand = (c: string) => parseInt(c + c, 16);
  if (h.length === 3 || h.length === 4) {
    return {
      r: expand(h[0]),
      g: expand(h[1]),
      b: expand(h[2]),
      a: h.length === 4 ? expand(h[3]) / 255 : 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** One channel of an rgb() argument list — `255`, `100%`, `.5` (alpha) or `50%` (alpha). */
function channelValue(raw: string, isAlpha: boolean): number | null {
  const s = raw.trim();
  if (!s) return null;
  const pct = s.endsWith("%");
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return null;
  if (isAlpha) return pct ? n / 100 : n;
  return pct ? (n / 100) * 255 : n;
}

function parseRgbFunction(input: string): Rgba | null {
  const m = RGB_RE.exec(input);
  if (!m) return null;
  // Both legacy `rgb(r, g, b, a)` and modern `rgb(r g b / a)` syntax.
  const parts = m[1].replace("/", " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const r = channelValue(parts[0], false);
  const g = channelValue(parts[1], false);
  const b = channelValue(parts[2], false);
  if (r == null || g == null || b == null) return null;
  const a = parts.length === 4 ? channelValue(parts[3], true) : 1;
  if (a == null) return null;
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Math.max(0, Math.min(1, a)) };
}

/** Parse any supported color string into RGBA. Returns null when unrecognized. */
export function parseColor(
  input: string | null | undefined,
  resolveVar: (name: string) => string = documentVarLookup,
  depth = 0,
): Rgba | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s || depth > 4) return null;

  const varMatch = VAR_RE.exec(s);
  if (varMatch) {
    const resolved = resolveVar(varMatch[1]);
    if (resolved) return parseColor(resolved, resolveVar, depth + 1);
    return varMatch[2] ? parseColor(varMatch[2], resolveVar, depth + 1) : null;
  }

  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return parseHex(named);

  if (s.startsWith("#")) return parseHex(s);
  return parseRgbFunction(s);
}

/** sRGB channel → linear, per WCAG 2.x. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) → 1 (white). Alpha is ignored — composite first. */
export function relativeLuminance(color: Pick<Rgba, "r" | "g" | "b">): number {
  return (
    0.2126 * linearize(color.r) +
    0.7152 * linearize(color.g) +
    0.0722 * linearize(color.b)
  );
}

/** WCAG contrast ratio between two luminances, 1 → 21. */
export function contrastRatio(lumA: number, lumB: number): number {
  const light = Math.max(lumA, lumB);
  const dark = Math.min(lumA, lumB);
  return (light + 0.05) / (dark + 0.05);
}

/** Source-over composite of a translucent color onto an opaque backdrop. */
export function compositeOver(fg: Rgba, backdrop: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + backdrop.r * (1 - a),
    g: fg.g * a + backdrop.g * (1 - a),
    b: fg.b * a + backdrop.b * (1 - a),
    a: 1,
  };
}

/**
 * Black or white — whichever reads better on `background`.
 *
 * Translucent backgrounds are composited over `opts.backdrop` (default white)
 * first, so a 10%-alpha fill is judged against what the user actually sees.
 */
export function contrastingTextColor(
  background: string | null | undefined,
  opts: ContrastOptions = {},
): string {
  const resolveVar = opts.resolveVar ?? documentVarLookup;
  const parsed = parseColor(background, resolveVar);
  if (!parsed) return opts.fallback ?? CONTRAST_BLACK;

  let solid = parsed;
  if (parsed.a < 1) {
    const backdrop = parseColor(opts.backdrop ?? CONTRAST_WHITE, resolveVar) ?? {
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    };
    solid = compositeOver(parsed, { ...backdrop, a: 1 });
  }

  const lum = relativeLuminance(solid);
  return contrastRatio(lum, 0) >= contrastRatio(lum, 1) ? CONTRAST_BLACK : CONTRAST_WHITE;
}
