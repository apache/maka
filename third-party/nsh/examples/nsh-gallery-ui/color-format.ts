// A color the picker reported, written as text in any of its formats, and
// the ink that reads on it: for the color picker's copy button, its format
// menu and its trigger (`look/color.tsx`). These are colors the user picks,
// content rather than the interface's look, so they are written out here.
import type { ColorFormat } from "nsh/base";

/** `v` to `decimals` places, trailing zeros dropped (as the picker writes its numbers). */
function number(v: number, decimals: number): string {
  const text = v.toFixed(decimals);
  const trimmed = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  return trimmed === "-0" ? "0" : trimmed;
}

/** The hue of an sRGB color, in degrees. */
function hue([r, g, b]: number[], max: number, d: number): number {
  if (d <= 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * A color the picker reported (`value`: `#rrggbbaa`) written as `format` writes it, as the picker writes it: for the
 * copy button, the format menu's previews and a trigger's text, which show any format, not only the picker's own.
 */
export function formatColor(value: string, format: ColorFormat): string {
  const hex = value.replace(/^#/, "");
  const at = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const rgb = [at(0), at(2), at(4)];
  const a = hex.length >= 8 ? at(6) : 1;
  const opaque = hex.length < 8 || hex.slice(6, 8).toLowerCase() === "ff";
  const tail = opaque ? "" : ` / ${number(a, 2)}`;
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const d = max - min;
  switch (format) {
    case "hex":
      return `#${opaque ? hex.slice(0, 6) : hex.slice(0, 8)}`.toLowerCase();
    case "rgb":
      return `rgb(${rgb.map((c) => Math.round(c * 255)).join(" ")}${tail})`;
    case "hsl": {
      const l = (max + min) / 2;
      const s = d <= 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      return `hsl(${number(hue(rgb, max, d), 1)} ${number(s * 100, 1)}% ${number(l * 100, 1)}%${tail})`;
    }
    case "hsb": {
      const s = max <= 0 ? 0 : d / max;
      return `hsb(${number(hue(rgb, max, d), 1)} ${number(s * 100, 1)}% ${number(max * 100, 1)}%${tail})`;
    }
    case "oklch": {
      const [r, g, b] = rgb.map(toLinear);
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
      const oa = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
      const ob = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      const chroma = Math.hypot(oa, ob);
      const h = chroma < 1e-4 ? 0 : ((Math.atan2(ob, oa) * 180) / Math.PI + 360) % 360;
      return `oklch(${number(lightness * 100, 1)}% ${number(chroma, 3)} ${number(h, 1)}${tail})`;
    }
  }
}

/** Ink that reads on `value` (a color the user picks, not the theme's): black on a light one, white on a dark one. */
export function inkOn(value: string): string {
  const hex = value.replace(/^#/, "");
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? "black" : "white";
}
