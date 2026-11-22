// Avatars' look, shared by the gallery and the documentation demos: a
// person's identity colors (the initials on a tint, the same person always
// the same hue), the GitHub pictures of NSH's maintainers, and an image that
// never loads, so the demos show the fallback.
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

/** NSH's maintainers, by name: their GitHub logins and account ids. */
export const MAINTAINERS = [
  { name: "Jason Lee", login: "huacnlee", id: 5518 },
  { name: "Sunli", login: "sunli829", id: 20092316 },
  { name: "Floyd Wang", login: "madcodelife", id: 28998859 },
] as const;

/**
 * The GitHub picture of `name`, one of NSH's maintainers (160 px, sharp
 * at the demos' largest avatar), or none for anyone else: they show their
 * initials.
 */
export function avatarPortrait(name: string): string | undefined {
  const person = MAINTAINERS.find((m) => m.name === name);
  return person && `https://avatars.githubusercontent.com/u/${person.id}?s=160`;
}

/** An image that never loads (bytes no decoder reads): the avatar's
 * fallback shows, as for a picture that is gone. */
export const AVATAR_BROKEN = "data:image/png;base64,AAAA";
