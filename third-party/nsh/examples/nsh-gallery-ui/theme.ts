// Internal design tokens and finishes shared by gallery and website demos.
import type { Tokens, ViewStyle } from "nsh";
import { token } from "nsh";
import { Easing } from "nsh";
import { colorScheme } from "nsh";
import finishes from "./finishes.json";

/** Whether the shared example UI shows its dark palette (reactive: reading it subscribes). */
export const isDark = () => colorScheme() !== "light";

/**
 * An object with `dark`'s keys whose getters read `dark` or `light` by the
 * appearance shown, for the finishes below: shadows and gradients are no
 * design tokens, so they stay here while every color is the theme's.
 */
function themed<T extends object>(dark: T, light: T): T {
  const out = {} as T;
  for (const key of Object.keys(dark) as (keyof T)[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => (isDark() ? dark : light)[key] });
  }
  return out;
}

/** The roles of the palette. */
export interface Palette {
  /** The page behind the cards. */
  background: string;
  /** A card. */
  surface: string;
  /** A surface inside a card. */
  inset: string;
  /** A control on a card (buttons, fields, tracks). */
  raised: string;
  /** An input's well: below the card and the insets it sits on. */
  field: string;
  /** An input's edge. */
  fieldBorder: string;
  border: string;
  /** Hairlines inside insets. */
  line: string;
  text: string;
  muted: string;
  faint: string;
  /** The accent as a foreground: text, icons, lines, small marks. */
  accent: string;
  /** The accent as a fill (buttons, bubbles), with `onAccent` on it. */
  accentFill: string;
  /** Text on the accent fill. */
  onAccent: string;
  /** The main action's button: light on the dark page, dark on the light one. */
  light: string;
  /** Text on `light`. */
  onLight: string;
  /** The app's sidebar, beside the page. */
  sidebar: string;
  /** The selected row of the sidebar. */
  sidebarSelected: string;
  /** The sidebar's edge and the toolbar's hairline. */
  sidebarBorder: string;
  /** A switch's track when off. */
  track: string;
  /** A switch's knob when off. */
  knob: string;
  /** Code inside insets. */
  code: string;
  info: string;
  warn: string;
  danger: string;
  up: string;
  down: string;
}

/** An object whose getters read the theme's tokens: reads in a reactive
 * scope (JSX, a `draw`, an effect) follow the appearance and the theme. */
function tokens<K extends string>(names: Record<K, keyof Tokens>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(names) as K[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => token(names[key]) });
  }
  return out;
}

/**
 * The shared example UI's look: a graphite page (or a paper one in light
 * appearance), cards with an inset surface, tabular numbers and one citrus
 * accent, its colors the tokens of `theme.json`. Desktops are compact
 * (28-point controls, 13-point labels), touch screens roomier (36 to 40
 * points).
 */
export const colors: Palette = tokens<keyof Palette>({
  background: "background",
  surface: "card",
  inset: "inset",
  raised: "raised",
  field: "field",
  fieldBorder: "input",
  border: "border",
  line: "line",
  text: "foreground",
  muted: "muted-foreground",
  faint: "faint",
  accent: "brand",
  accentFill: "brand-fill",
  onAccent: "on-brand",
  light: "primary",
  onLight: "primary-foreground",
  sidebar: "sidebar",
  sidebarSelected: "sidebar-accent",
  sidebarBorder: "sidebar-border",
  track: "track",
  knob: "knob",
  code: "code",
  info: "info",
  warn: "warn",
  danger: "destructive",
  up: "up",
  down: "down",
});

/** `color` at opacity `a`. */
export function alpha(color: string, a: number) {
  return `color-mix(in srgb, ${color} ${a * 100}%, transparent)`;
}

/** The charts' series colors, in order (`theme.json`'s `chart-1` to
 * `chart-5`): the brand's citrus first, then graphite from dark to light,
 * so one series leads and the rest stay as quiet as the interface. */
export const chart = tokens({
  s1: "chart-1",
  s2: "chart-2",
  s3: "chart-3",
  s4: "chart-4",
  s5: "chart-5",
});

/** Translucent tints of the tones, for fills behind text. */
export const tints = tokens({
  accent: "brand-tint",
  info: "info-tint",
  warn: "warn-tint",
  danger: "destructive-tint",
  up: "up-tint",
  down: "down-tint",
});

/** A surface's finish: a gradient over its color and its shadows. */
export interface Finish {
  backgroundColor?: string;
  backgroundImage?: string;
  boxShadow: string;
  borderColor?: string;
  backdropFilter?: string;
}

/**
 * Light and depth, kept quiet: one-color edges (corners join cleanly), a
 * hard 1-point drop under what stands up and a 1-point inner shade in what
 * is sunk; only floating surfaces (menus, glass) cast a soft
 * shadow. `hover` and `pressed` are a raised control's states, `fill` a
 * slider's or a meter's run of the accent.
 */
export const finish = themed<
  Record<"card" | "inset" | "field" | "raised" | "hover" | "pressed" | "light" | "accent" | "track" | "fill" | "knob" | "pill" | "chip" | "glass" | "menu", Finish>
>(finishes.dark, finishes.light);

export type Tone = "neutral" | "accent" | "info" | "warn" | "danger" | "up" | "down";

/** The color of a tone. */
export const toneColor = (tone: Tone) => (tone === "neutral" ? colors.muted : colors[tone]);
/** The tint of a tone. */
export const toneTint = (tone: Tone) => (tone === "neutral" ? colors.raised : tints[tone]);

/** The monospaced family, for code (API names, identifiers). Figures use
 * the system font with tabular numbers instead. */
export const mono = "monospace";
/** Corner radii (`theme.json`'s `radius-card`, `radius`, `radius-control`). */
export const radius = {
  get card() {
    return token("radius-card");
  },
  get inset() {
    return token("radius");
  },
  get control() {
    return token("radius-control");
  },
};

/** The system header's colors on every page (iOS, Android). */
export const header = {
  get headerStyle() {
    return { backgroundColor: colors.background, color: colors.text, tintColor: colors.accent };
  },
};


/**
 * The motion every control shares: quick, slightly springy. `control` and
 * `move` are gpui-kit's `spring_control` (a 180 ms response, no overshoot:
 * a mark or a fill coming and going) and `spring_move` (280 ms, a damping
 * ratio of 0.85: a thumb or an indicator traveling) as a unit mass's
 * stiffness (2π / response)² and damping 2 · ratio · 2π / response.
 */
export const motion = {
  press: { stiffness: 520, damping: 34 },
  settle: { stiffness: 320, damping: 30 },
  control: { stiffness: 1218, damping: 70 },
  move: { stiffness: 504, damping: 38 },
  enter: { duration: 420, easing: Easing.out(Easing.cubic) },
} as const;

/**
 * A pressable under the pointer (`hoverStyle`): a whisper of the text color
 * over its surface, quieter than pressed and than selected. Leave it off a
 * disabled control and off a selected one, whose own fill shows.
 */
export const hovered = (): ViewStyle => ({ backgroundColor: alpha(colors.text, 0.05) });

/**
 * The keyboard focus (`focusStyle`): a 2-point outline in the theme's info
 * color, inset by default (`offset` moves it relative to the edge).
 */
export const focusRing = (offset = -2): ViewStyle => ({ outlineStyle: "solid", outlineWidth: 2, outlineColor: colors.info, outlineOffset: offset });
