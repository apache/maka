// Avatars' look, shared by the gallery and the documentation demos: a
// person's identity colors (the initials on a tint, the same person always
// the same hue) and portraits drawn as SVG, so the demos show pictures
// offline, and an image that never loads, so they show the fallback.
import { isDark } from "./theme";

/** The hues of the identity ring: twelve, evenly spaced. */
const HUES = 12;

/** FNV-1a of `text`: a stable hash, so a name keeps its hue. */
function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The hue of `name` on the ring, in degrees. */
export const avatarHue = (name: string) => (hash(name) % HUES) * (360 / HUES);

/** `#rrggbb` of an OkLCH color (clipped to sRGB), so it fits an arbitrary
 * Tailwind class (`text-[#…]`) as well as a style. */
function oklch(l: number, c: number, h: number): string {
  const r = (h * Math.PI) / 180;
  const a = c * Math.cos(r);
  const b = c * Math.sin(r);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return (
    "#" +
    channel(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3) +
    channel(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3) +
    channel(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3)
  );
}

/**
 * The colors a fallback with `name`'s initials draws itself in, as
 * `gpui-component`'s avatar picks them: twelve OkLCH hues at one lightness
 * and chroma, so every avatar has one visual weight and its initials hold
 * WCAG AA on every hue, in light and dark appearance.
 */
export function avatarIdentity(name: string) {
  const h = avatarHue(name);
  return isDark()
    ? { background: oklch(0.3, 0.05, h), foreground: oklch(0.82, 0.11, h), border: oklch(0.36, 0.06, h) }
    : { background: oklch(0.97, 0.032, h), foreground: oklch(0.5, 0.145, h), border: oklch(0.89, 0.05, h) };
}

/** `#rrggbb` of an HSL color (SVG's paint takes hex everywhere). */
function hex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * A portrait for `name`: head and shoulders over a gradient of the
 * person's hue, as an SVG `data:` URI (96 × 96), which every platform
 * loads without a network.
 */
export function avatarPortrait(name: string): string {
  const h = avatarHue(name);
  const hair = (h + 200) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${hex(h, 0.7, 0.74)}"/><stop offset="1" stop-color="${hex((h + 36) % 360, 0.55, 0.46)}"/>` +
    `</linearGradient></defs>` +
    `<rect width="96" height="96" fill="url(#g)"/>` +
    `<path d="M14 96c3-19 17-29 34-29s31 10 34 29z" fill="${hex(hair, 0.28, 0.24)}"/>` +
    `<circle cx="48" cy="42" r="17" fill="${hex(28, 0.45, 0.82)}"/>` +
    `<path d="M30 40c0-13 8-21 18-21s19 7 18 21c-4-7-10-10-18-10s-14 3-18 10z" fill="${hex(hair, 0.32, 0.2)}"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** An image that never loads (bytes no decoder reads): the avatar's
 * fallback shows, as for a picture that is gone. */
export const AVATAR_BROKEN = "data:image/png;base64,AAAA";
