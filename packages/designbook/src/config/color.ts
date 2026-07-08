/**
 * Framework-free color conversion between CSS OKLCH strings, hex, and the
 * `{ r, g, b, a }` (0..1, gamma sRGB) shape Figma COLOR variables use.
 *
 * Figma stores COLOR variable values as gamma-encoded (display) sRGB floats in
 * 0..1, so that is the target space here — the OKLCH → sRGB path ends in the
 * gamma transfer function, and the reverse begins by undoing it. The matrices
 * are the standard Björn Ottosson OKLab ↔ linear-sRGB coefficients.
 *
 * Deliberately free of React/DOM/Node imports so it can be unit-tested and
 * reused in the browser (theme adapter), on the server, and in tests.
 */

type Oklch = { L: number; C: number; H: number; a: number };
type Rgba = { r: number; g: number; b: number; a: number };

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Rounds to `digits` decimal places, dropping trailing zeros via Number. */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Parses a `0..1` or `NN%` component into a 0..1 number, or null. */
function parseUnitComponent(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  if (text.endsWith("%")) {
    const n = Number.parseFloat(text.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses an `oklch(L C H)` or `oklch(L C H / A)` string. `L` may be `0..1` or a
 * percentage; `A` may be `0..1` or a percentage; `C` and `H` are plain numbers
 * (`H` optionally suffixed `deg`). Returns null if the string isn't oklch.
 */
function parseOklch(str: string): Oklch | null {
  const match = /^\s*oklch\(\s*([^)]*)\)\s*$/i.exec(str);
  if (!match) return null;

  const body = match[1].trim();
  const [coords, alphaPart] = body.split("/");
  const parts = coords.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const L = parseUnitComponent(parts[0]);
  const C = Number.parseFloat(parts[1]);
  const H = Number.parseFloat(parts[2].replace(/deg$/i, ""));
  if (L === null || !Number.isFinite(C) || !Number.isFinite(H)) return null;

  let a = 1;
  if (alphaPart !== undefined) {
    const parsedAlpha = parseUnitComponent(alphaPart);
    if (parsedAlpha !== null) a = clamp01(parsedAlpha);
  }

  return { L, C, H, a };
}

function gammaEncode(c: number): number {
  const encoded =
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp01(encoded);
}

function gammaDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** OKLCH → `{ r, g, b, a }` in 0..1 gamma sRGB (clamped to gamut). */
function oklchToRgb({ L, C, H, a }: Oklch): Rgba {
  const hRad = (H * Math.PI) / 180;
  const A = C * Math.cos(hRad);
  const B = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: gammaEncode(rl),
    g: gammaEncode(gl),
    b: gammaEncode(bl),
    a,
  };
}

/** `{ r, g, b, a }` in 0..1 gamma sRGB → OKLCH (H normalized 0..360). */
function rgbToOklch({ r, g, b, a }: Rgba): Oklch {
  const rl = gammaDecode(r);
  const gl = gammaDecode(g);
  const bl = gammaDecode(b);

  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  // Achromatic colors have an undefined hue; report 0 for stability.
  if (C < 1e-6) H = 0;

  return { L, C, H, a: a ?? 1 };
}

function channelToHex(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** `{ r, g, b }` (0..1) → `#rrggbb` (alpha dropped; suits `<input type=color>`). */
function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` into `{ r, g, b, a }` 0..1. */
function hexToRgb(hex: string): Rgba | null {
  const text = hex.trim().replace(/^#/, "");
  let r: number;
  let g: number;
  let b: number;
  let a = 1;

  if (text.length === 3 || text.length === 4) {
    r = Number.parseInt(text[0] + text[0], 16);
    g = Number.parseInt(text[1] + text[1], 16);
    b = Number.parseInt(text[2] + text[2], 16);
    if (text.length === 4) a = Number.parseInt(text[3] + text[3], 16) / 255;
  } else if (text.length === 6 || text.length === 8) {
    r = Number.parseInt(text.slice(0, 2), 16);
    g = Number.parseInt(text.slice(2, 4), 16);
    b = Number.parseInt(text.slice(4, 6), 16);
    if (text.length === 8) a = Number.parseInt(text.slice(6, 8), 16) / 255;
  } else {
    return null;
  }

  if (![r, g, b].every(Number.isFinite)) return null;
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

/** OKLCH → `#rrggbb`. */
function oklchToHex(color: Oklch): string {
  return rgbToHex(oklchToRgb(color));
}

/**
 * Parses an `rgb()` / `rgba()` string — comma (`rgb(1, 2, 3)`) or modern
 * space (`rgb(1 2 3 / 0.5)`) syntax, integer 0..255 or percentage channels —
 * into `{ r, g, b, a }` 0..1. Returns null if the string isn't rgb.
 */
function parseRgbString(str: string): Rgba | null {
  const match = /^\s*rgba?\(\s*([^)]*)\)\s*$/i.exec(str);
  if (!match) return null;

  const body = match[1].trim();
  let coords = body;
  let alphaPart: string | undefined;

  const slashIndex = body.indexOf("/");
  if (slashIndex !== -1) {
    coords = body.slice(0, slashIndex);
    alphaPart = body.slice(slashIndex + 1);
  }

  const parts = coords
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts.length === 4) {
    if (alphaPart !== undefined) return null;
    alphaPart = parts.pop();
  }

  const channels: number[] = [];
  for (const part of parts) {
    if (part.endsWith("%")) {
      const n = Number.parseFloat(part.slice(0, -1));
      if (!Number.isFinite(n)) return null;
      channels.push(clamp01(n / 100));
    } else {
      const n = Number.parseFloat(part);
      if (!Number.isFinite(n)) return null;
      channels.push(clamp01(n / 255));
    }
  }

  let a = 1;
  if (alphaPart !== undefined) {
    const parsedAlpha = parseUnitComponent(alphaPart);
    if (parsedAlpha === null) return null;
    a = clamp01(parsedAlpha);
  }

  return { r: channels[0], g: channels[1], b: channels[2], a };
}

/**
 * Parses any CSS color string designbook encounters — `rgb()`/`rgba()` (what
 * `getComputedStyle` returns), `oklch()`, hex, and the `transparent` keyword —
 * into `{ r, g, b, a }` 0..1 gamma sRGB. Returns null for anything else.
 */
function parseCssColor(value: string): Rgba | null {
  const text = value.trim();
  if (text === "") return null;
  if (text.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const rgb = parseRgbString(text);
  if (rgb) return rgb;

  const oklch = parseOklch(text);
  if (oklch) return oklchToRgb(oklch);

  if (text.startsWith("#")) return hexToRgb(text);
  return null;
}

/**
 * Serializes OKLCH to a CSS string with sensible precision: `oklch(L C H)`, or
 * `oklch(L C H / A)` when alpha < 1.
 */
function formatOklch({ L, C, H, a }: Oklch): string {
  const core = `oklch(${roundTo(L, 4)} ${roundTo(C, 4)} ${roundTo(H, 2)}`;
  return a < 1 ? `${core} / ${roundTo(a, 4)})` : `${core})`;
}

export {
  formatOklch,
  hexToRgb,
  oklchToHex,
  oklchToRgb,
  parseCssColor,
  parseOklch,
  rgbToHex,
  rgbToOklch,
};
export type { Oklch, Rgba };
