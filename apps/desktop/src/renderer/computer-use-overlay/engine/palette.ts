// Agent-cursor colour palettes — faithful 1:1 port of trycua/cua's
// cursor-overlay/src/palette.rs (itself a port of AgentCursorPalette.cs).
// Colours are [R,G,B] 0-255. The overlay picks a palette from the session id so
// distinct agent runs are visually distinct but a given id is stable.
export type Rgb = readonly [number, number, number];

export interface Palette {
  name: string;
  /** Tip colour (lightest, gradient position 0.0). */
  cursorStart: Rgb;
  /** Mid-gradient colour (position 0.53). */
  cursorMid: Rgb;
  /** Tail colour (position 1.0). */
  cursorEnd: Rgb;
  /** Outer bloom layer. */
  bloomOuter: Rgb;
  /** Inner bloom layer (brighter core). */
  bloomInner: Rgb;
}

type PaletteData = readonly [string, Rgb, Rgb, Rgb, Rgb, Rgb];

// (name, cursorStart, cursorMid, cursorEnd, bloomOuter, bloomInner)
const PALETTE_DATA: readonly PaletteData[] = [
  ['default_blue', [219, 238, 255], [94, 192, 232], [84, 205, 160], [188, 232, 252], [238, 248, 255]],
  ['soft_purple', [238, 226, 255], [178, 132, 255], [118, 194, 255], [214, 188, 255], [246, 238, 255]],
  ['rose_gold', [255, 231, 238], [247, 132, 170], [255, 181, 108], [255, 190, 211], [255, 243, 232]],
  ['mint_lime', [226, 255, 240], [96, 218, 174], [178, 229, 72], [178, 245, 217], [241, 255, 231]],
  ['amber', [255, 244, 214], [244, 178, 66], [255, 126, 92], [255, 219, 140], [255, 248, 225]],
  ['aqua', [221, 252, 255], [76, 204, 224], [63, 222, 166], [172, 241, 249], [236, 255, 251]],
  ['orchid', [252, 228, 255], [221, 113, 236], [255, 139, 196], [237, 181, 246], [255, 239, 252]],
  ['crimson', [255, 226, 226], [232, 82, 98], [150, 94, 255], [255, 168, 178], [255, 240, 241]],
  ['chartreuse', [247, 255, 218], [184, 220, 54], [72, 190, 119], [224, 247, 128], [249, 255, 232]],
  ['cobalt', [226, 235, 255], [80, 126, 236], [91, 219, 222], [170, 195, 255], [239, 246, 255]],
];

function fromData(d: PaletteData): Palette {
  return { name: d[0], cursorStart: d[1], cursorMid: d[2], cursorEnd: d[3], bloomOuter: d[4], bloomInner: d[5] };
}


/**
 * Maka's brand cursor palette, derived from the app's primary token
 * `--action` = oklch(0.62 0.19 264) (a blue/indigo). Gradient tip→tail around it
 * plus a soft brand bloom, so the agent cursor reads as "Maka" rather than a
 * random per-session hue. (FOLLOW-UP: thread the live --primary from the renderer
 * so it tracks theme changes instead of this baked snapshot.)
 */
export function makaBrandPalette(): Palette {
  return {
    name: 'maka_brand',
    cursorStart: [144, 182, 255], // lightest at the tip
    cursorMid: [73, 126, 247], // the primary
    cursorEnd: [71, 97, 228], // deeper at the tail
    bloomOuter: [157, 189, 255],
    bloomInner: [212, 229, 255],
  };
}

export const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
