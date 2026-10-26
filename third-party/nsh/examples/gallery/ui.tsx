import type { JSX, ScrollProps, Tokens, ViewStyle } from "nsh";
import { computed, effect, Image, Scroll, signal, Text, token, View } from "nsh";
import { reduceMotion } from "nsh/accessibility";
import { createAnimatedValue, Easing } from "nsh/animated";
import { colorScheme, platform, setColorScheme, windowSize } from "nsh/device";
import { keymap } from "nsh/keymap";
import { Button as BaseButton, Sheet as BaseSheet, safeArea, Switch, Tab, Tabs } from "nsh/base";
import { nav } from "./nav";
import { Icon, type IconName } from "./icons";
import logoDark from "./logo-dark.svg";
import logoLight from "./logo-light.svg";

/** Whether the gallery shows its dark palette (reactive: reading it subscribes). */
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
 * The gallery's look: a graphite page (or a paper one in light
 * appearance), cards with an inset surface, tabular numbers and one citrus
 * accent, its colors the tokens of `theme.json`. Sizes are for phones:
 * 16 pt gutters, 44 pt touch targets, 15 pt body text. The desktop layout
 * (`desktop`) keeps them and puts more side by side.
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
 * Light and depth: gentle top-to-bottom gradients, a highlight along top
 * edges and soft shadows, so cards, controls and buttons read as surfaces.
 */
export const finish = themed<Record<"card" | "inset" | "field" | "raised" | "light" | "accent" | "track" | "knob" | "pill" | "chip" | "glass" | "menu", Finish>>(
  {
    card: {
      backgroundImage: "linear-gradient(180deg, #1b1c20 0%, #191a1d 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 16px 36px -20px rgba(0,0,0,0.75)",
    },
    inset: { boxShadow: "inset 0 1px 3px rgba(0,0,0,0.55)" },
    field: { boxShadow: "inset 0 1px 2px rgba(0,0,0,0.55)" },
    raised: {
      backgroundImage: "linear-gradient(180deg, #2b2d32 0%, #24262a 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 1px rgba(0,0,0,0.4), 0 6px 14px -7px rgba(0,0,0,0.7)",
    },
    light: {
      backgroundImage: "linear-gradient(180deg, #fbfbfc 0%, #e3e5e8 100%)",
      boxShadow: "inset 0 1px 0 #ffffff, 0 1px 1px rgba(0,0,0,0.4), 0 8px 18px -8px rgba(0,0,0,0.75)",
    },
    accent: {
      backgroundImage: "linear-gradient(180deg, #d6f78a 0%, #c1ea5c 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 1px rgba(0,0,0,0.4), 0 8px 20px -9px rgba(200,242,109,0.4)",
    },
    track: { boxShadow: "inset 0 1px 2px rgba(0,0,0,0.5)" },
    /** A knob or handle over a track. */
    knob: { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 2px 6px rgba(0,0,0,0.45)" },
    /**
     * Lit glass: a pill that floats over a track (the selected segment, a
     * small round button), a specular top, a faint inner edge, a lower rim.
     */
    pill: {
      backgroundColor: "#2b2d32",
      backgroundImage: "linear-gradient(180deg, #2f3136 0%, #2a2c30 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 1px rgba(0,0,0,0.4), 0 6px 14px -7px rgba(0,0,0,0.7)",
      borderColor: "rgba(255,255,255,0.08)",
    },
    /** A tinted capsule's rim and highlight (badges). */
    chip: { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(0,0,0,0.18)" },
    /** A bar floating over content: translucent, blurred, rimmed. */
    glass: {
      backgroundColor: "rgba(22,23,26,0.62)",
      backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.019) 60%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.09), 0 -8px 24px rgba(0,0,0,0.28)",
      borderColor: "rgba(255,255,255,0.07)",
      backdropFilter: "blur(20px)",
    },
    /** A floating panel (menus, the composer): glass, denser for reading. */
    menu: {
      backgroundColor: "rgba(30,32,36,0.82)",
      backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.043) 0%, rgba(255,255,255,0.024) 40%, rgba(255,255,255,0.018) 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.11), inset 0 -1px 0 rgba(0,0,0,0.25), 0 12px 32px rgba(0,0,0,0.42)",
      borderColor: "rgba(255,255,255,0.08)",
      backdropFilter: "blur(24px)",
    },
  },
  {
    card: {
      backgroundImage: "linear-gradient(180deg, #ffffff 0%, #fdfdfc 100%)",
      boxShadow: "inset 0 1px 0 #ffffff, 0 1px 1px rgba(20,20,10,0.04), 0 14px 32px -18px rgba(20,20,10,0.2)",
    },
    inset: { boxShadow: "inset 0 1px 2px rgba(20,20,10,0.07)" },
    field: { boxShadow: "inset 0 1px 2px rgba(20,20,10,0.09)" },
    raised: {
      backgroundImage: "linear-gradient(180deg, #ffffff 0%, #f6f6f2 100%)",
      boxShadow: "inset 0 1px 0 #ffffff, 0 1px 1px rgba(20,20,10,0.06), 0 5px 12px -6px rgba(20,20,10,0.18)",
    },
    light: {
      backgroundImage: "linear-gradient(180deg, #2e3035 0%, #1b1c20 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16), 0 1px 1px rgba(20,20,10,0.2), 0 7px 14px -7px rgba(20,20,10,0.5)",
    },
    accent: {
      backgroundImage: "linear-gradient(180deg, #d6f78a 0%, #c1ea5c 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 1px rgba(80,110,10,0.2), 0 7px 14px -7px rgba(110,150,20,0.55)",
    },
    track: { boxShadow: "inset 0 1px 2px rgba(20,20,10,0.08)" },
    knob: { boxShadow: "inset 0 1px 0 #ffffff, 0 1px 4px rgba(20,20,10,0.28)" },
    pill: {
      backgroundColor: "#ffffff",
      backgroundImage: "linear-gradient(180deg, #ffffff 0%, #f6f6f2 100%)",
      boxShadow: "inset 0 1px 0 #ffffff, 0 1px 1px rgba(20,20,10,0.06), 0 5px 12px -6px rgba(20,20,10,0.18)",
      borderColor: "rgba(20,20,10,0.14)",
    },
    chip: { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.65), inset 0 -1px 0 rgba(20,20,10,0.04)" },
    glass: {
      backgroundColor: "rgba(250,250,248,0.66)",
      backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.472) 0%, rgba(255,255,255,0.227) 60%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 -6px 20px rgba(20,20,10,0.06)",
      borderColor: "rgba(20,20,10,0.07)",
      backdropFilter: "blur(20px)",
    },
    menu: {
      backgroundColor: "rgba(255,255,255,0.84)",
      backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.497) 0%, rgba(255,255,255,0.287) 40%, rgba(255,255,255,0.217) 100%)",
      boxShadow: "inset 0 1px 0 #ffffff, inset 0 -1px 0 rgba(20,20,10,0.05), 0 12px 32px rgba(20,20,10,0.12)",
      borderColor: "rgba(20,20,10,0.08)",
      backdropFilter: "blur(24px)",
    },
  },
);

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
 * A page's header where the app draws it (desktops, the web: `<NavPage
 * header>`): a back button while the page is above another, the title, and
 * `right`. Phones show their system header with the page's `title` instead.
 */
export function PageHeader(props: {
  title: string;
  /** The bottom page of its stack: no back button. */
  root?: boolean;
  /** What back does (default: pop the page). */
  onBack?: () => void;
  /** Replaces the back button. */
  left?: JSX.Element;
  /** Replaces the title. */
  center?: JSX.Element;
  right?: JSX.Element;
  /** The bar's fill (default the page's background). */
  background?: string;
  /** The back button's color (default the accent). */
  tint?: string;
  /** Over the content (a transparent header): no fill, no hairline. */
  transparent?: boolean;
}) {
  const back = () => !props.left && !props.root && nav.routes().length > 1;
  const tint = () => props.tint ?? colors.accent;
  return (
    <View
      style={{
        height: 52,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        backgroundColor: props.transparent ? "transparent" : (props.background ?? colors.background),
        borderBottomWidth: props.transparent || props.background ? 0 : 1,
        borderBottomColor: colors.line,
      }}
    >
      {props.left}
      <If when={back()}>
        <View
          onPress={() => (props.onBack ? props.onBack() : nav.pop())}
          role="button"
          accessibilityLabel="Back"
          hitSlop={6}
          class="hover:bg-hover active:bg-accent"
          style={{ height: 32, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 10, borderRadius: radius.control, cursor: "pointer" }}
        >
          <Icon name="back" size={18} tint={tint()} />
          <Text style={{ fontSize: 14, fontWeight: "500", color: tint() }}>Back</Text>
        </View>
      </If>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: back() || props.left ? 0 : 4 }}>
        {props.center ?? (
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>
            {props.title}
          </Text>
        )}
      </View>
      {props.right}
    </View>
  );
}

/**
 * The thumb of a resize handle (`handleThumbClass`), as gpui-component
 * draws it: none at rest, so the hairlines stay quiet; a faint pill
 * grows in under the pointer, and a long solid one while pressed or
 * dragged.
 */
export const handleThumb =
  "h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition duration-150 ease-out group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100";

/**
 * Instructions for the device's input: `touch` on phones and tablets,
 * `pointer` on desktops (a mouse, a touchpad, a keyboard).
 */
export const hint = (touch: string, pointer: string) => (platform.idiom === "desktop" ? pointer : touch);

/**
 * Desktops' way to refresh what phones pull down (the mouse does not drag
 * scroll views): Ctrl+R / Cmd+R calls `refresh` while the calling component
 * shows, next to the refresh button the demo shows. Browsers keep the key to
 * reload the page, and the development hosts to reload the app. Returns the
 * key's label for the hint, or null where it is not bound.
 */
export function bindRefresh(refresh: () => void): string | null {
  if (platform.idiom !== "desktop" || platform.os === "web") return null;
  keymap.bind("mod+r", refresh);
  return keymap.label("mod+r");
}

/** The width of the desktop layout's sidebar. */
export const SIDEBAR = 264;

/**
 * Whether the gallery takes its desktop layout: a sidebar of the demos next
 * to the open one, demos in columns, hover states. Desktops take it from
 * 700 pt wide, other platforms from 900 pt (an iPad in landscape, a wide
 * Mac Catalyst window); phones never do. Below that it is the phone layout,
 * unchanged. The shell remounts when it changes, so demos read it once.
 */
export const desktop = computed(() => windowSize().width >= (platform.idiom === "desktop" ? 700 : 900));

/** Whether the desktop layout shows its sidebar (the toggle in the demo's
 * toolbar and Ctrl+B / Cmd+B hide and show it; kept while the app runs). */
export const sidebarOpen = signal(true);

/** The width of the desktop layout's content pane, right of the sidebar. */
export const paneWidth = () => windowSize().width - (sidebarOpen() ? SIDEBAR : 0);

/** How many columns at least `min` pt wide fit in `width` (the content
 * pane by default), with `gap` between them and 24 pt gutters: 1 to `max`. */
export const columnsFor = (min: number, max: number, width = paneWidth(), gap = 20) =>
  Math.max(1, Math.min(max, Math.floor((width - 48 + gap) / (min + gap))));

/** The motion every control shares: quick, slightly springy. */
export const motion = {
  press: { stiffness: 520, damping: 34 },
  settle: { stiffness: 320, damping: 30 },
  enter: { duration: 420, easing: Easing.out(Easing.cubic) },
} as const;

/**
 * A pressable under the pointer (`hoverStyle`): a whisper of the text color
 * over its surface, quieter than pressed and than selected. Leave it off a
 * disabled control and off a selected one, whose own fill shows.
 */
export const hovered = (): ViewStyle => ({ backgroundColor: alpha(colors.text, 0.05) });

/**
 * The keyboard focus (`focusStyle`): a 2-point ring of `info` inside the
 * view's edge, so a card's rounded clip does not cut it (`offset` 2 puts it
 * outside, around a filled button).
 */
export const focusRing = (offset = -2): ViewStyle => ({ outlineStyle: "solid", outlineWidth: 2, outlineColor: colors.info, outlineOffset: offset });

/**
 * A pressable that sinks a little under the finger and springs back (the
 * spring runs natively; only press in / out reach JS).
 */
export function Press(props: {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** How far it shrinks (default 0.97). */
  scale?: number;
  style?: ViewStyle;
  role?: "button" | "tab" | "switch" | "link";
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean };
  hitSlop?: number;
  children: JSX.Element;
}) {
  const s = createAnimatedValue(1);
  return (
    <View
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={props.disabled}
      onPressDown={() => s.spring(props.scale ?? 0.97, motion.press)}
      onPressUp={() => s.spring(1, motion.press)}
      role={props.role ?? "button"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.accessibilityState}
      hitSlop={props.hitSlop}
      style={[props.style ?? null, { transform: [{ scale: s }], opacity: props.disabled ? 0.4 : 1 }]}
    >
      {props.children}
    </View>
  );
}

/**
 * `Press`'s feedback for a `Tab` of `nsh/base`, which reports no press down
 * to spring with: it sinks a little while pressed and eases back, and takes
 * presses 4 pt around it without taking more room (a hit slop). Spread
 * `style` and `activeStyle` into the tab's.
 */
export const tabPress = {
  style: { margin: -4, padding: 4, transitionProperty: "transform", transitionDuration: 150, transitionTimingFunction: "ease-out" },
  activeStyle: { transform: [{ scale: 0.97 }] },
} satisfies { style: ViewStyle; activeStyle: ViewStyle };

/**
 * Fades and lifts its content in once mounted; `index` staggers siblings
 * (40 ms apart). `flex` lets it wrap a page that fills its parent.
 */
export function Appear(props: { index?: number; flex?: boolean; children: JSX.Element }) {
  const t = createAnimatedValue(0);
  t.timing(1, { ...motion.enter, delay: Math.min(8, props.index ?? 0) * 40 });
  return (
    <View style={{ flex: props.flex ? 1 : undefined, opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }}>
      {props.children}
    </View>
  );
}

/** A rounded icon tile. */
export function IconTile(props: { name: IconName; tint?: string; size?: number }) {
  const size = props.size ?? 40;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.raised,
        ...finish.raised,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={props.name} size={size * 0.5} tint={props.tint ?? colors.text} />
    </View>
  );
}

/**
 * A card: an optional icon, a title and a subtitle, something on the right
 * (a badge, an action), then the content on an inset surface (or bare with
 * `flush`).
 */
export function Card(props: {
  icon?: IconName;
  title?: string;
  subtitle?: JSX.Element;
  right?: JSX.Element;
  flush?: boolean;
  style?: ViewStyle;
  children: JSX.Element;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.card,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          padding: 5,
          ...finish.card,
        },
        props.style ?? null,
      ]}
    >
      <If when={props.title}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 11, paddingTop: 11, paddingBottom: 12 }}>
          <If when={props.icon}>
            <IconTile name={props.icon!} />
          </If>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{props.title}</Text>
            <If when={props.subtitle}>
              <Text numberOfLines={2} style={{ fontSize: 13, color: colors.muted }}>
                {props.subtitle}
              </Text>
            </If>
          </View>
          {props.right}
        </View>
      </If>
      <If when={!props.flush} else={props.children}>
        <Inset>{props.children}</Inset>
      </If>
    </View>
  );
}

/** The darker surface inside a card. */
export function Inset(props: { gap?: number; padding?: number; children: JSX.Element }) {
  return (
    <View
      style={{
        backgroundColor: colors.inset,
        borderRadius: radius.inset,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.line,
        ...finish.inset,
        padding: props.padding ?? 14,
        gap: props.gap ?? 12,
      }}
    >
      {props.children}
    </View>
  );
}

/** A caption row: a label on the left, a quieter note on the right. */
export function Caption(props: { label: JSX.Element; note?: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text style={{ flex: 1, fontSize: 14, color: colors.muted }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text>
      </If>
    </View>
  );
}

/** A large figure with a tinted note after it ("38 / 1k  would pass"). */
export function Figure(props: { value: string; unit?: string; note?: string; tone?: Tone }) {
  return (
    <Text style={{ fontSize: 32, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: -0.5 }}>
      {props.value}
      <If when={props.unit}>
        <Text style={{ fontSize: 17, fontWeight: "400", color: colors.muted }}> {props.unit}</Text>
      </If>
      <If when={props.note}>
        <Text style={{ fontSize: 15, fontWeight: "500", color: toneColor(props.tone ?? "accent") }}> {props.note}</Text>
      </If>
    </Text>
  );
}

/** A small label in a tinted capsule. */
export function Badge(props: { label: string; tone?: Tone; outline?: boolean }) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View
      style={{
        paddingHorizontal: 10,
        height: 26,
        borderRadius: 13,
        justifyContent: "center",
        backgroundColor: props.outline ? "transparent" : toneTint(tone()),
        boxShadow: props.outline ? undefined : finish.chip.boxShadow,
        borderWidth: 1,
        borderColor: props.outline ? toneColor(tone()) : alpha(tone() === "neutral" ? colors.text : toneColor(tone()), 0.1),
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "500", color: tone() === "neutral" ? colors.text : toneColor(tone()) }}>{props.label}</Text>
    </View>
  );
}

/** A label above a value, for grids of figures. */
export function Stat(props: { label: string; value: string; tone?: Tone; width?: `${number}%` }) {
  return (
    <View style={{ width: props.width, gap: 3, paddingVertical: 4 }}>
      <Text style={{ fontSize: 12, color: colors.muted }}>{props.label}</Text>
      <Text style={{ fontSize: 15, color: props.tone ? toneColor(props.tone) : colors.text, fontVariant: ["tabular-nums"] }}>
        {props.value}
      </Text>
    </View>
  );
}

/** A colored square and a label, for chart legends. */
export function Legend(props: { color: string; label: string; value?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: props.color }} />
      <Text style={{ fontSize: 13, color: colors.muted }}>
        {props.label}
        <If when={props.value}>
          <Text style={{ color: colors.text, fontVariant: ["tabular-nums"] }}> {props.value}</Text>
        </If>
      </Text>
    </View>
  );
}

/** A row inside an inset, with a hairline above all but the first. */
export function Row(props: { first?: boolean; onPress?: () => void; children: JSX.Element }) {
  return (
    <View
      onPress={props.onPress}
      activeStyle={props.onPress ? { backgroundColor: colors.raised } : undefined}
      style={{
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      {props.children}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "accent" | "ghost";

/**
 * A button, 44 pt tall (32 pt `small`, for pointer-sized surfaces):
 * `primary` is light (the main action), `secondary` dark, `accent` citrus
 * (the theme's `brand-fill`). A `color` fills it with that color instead.
 */
export function Button(props: {
  label: string;
  variant?: ButtonVariant;
  color?: string;
  icon?: IconName;
  disabled?: boolean;
  /** Grows to share a row with its siblings. */
  flex?: number;
  size?: "small" | "regular";
  onPress: () => void;
}) {
  const small = () => props.size === "small";
  // `nsh/base`'s Button gives the behavior (presses, disabled, the button
  // role); the look below is the gallery's own.
  const scale = createAnimatedValue(1);
  const variant = () => props.variant ?? "primary";
  const bg = () =>
    props.color ?? (variant() === "primary" ? colors.light : variant() === "accent" ? colors.accentFill : variant() === "ghost" ? "transparent" : colors.raised);
  const fg = () => (props.color ? "#ffffff" : variant() === "primary" ? colors.onLight : variant() === "accent" ? colors.onAccent : colors.text);
  return (
    <BaseButton
      onPress={props.onPress}
      onPressDown={() => scale.spring(0.97, motion.press)}
      onPressUp={() => scale.spring(1, motion.press)}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      hoverStyle={props.disabled ? undefined : { opacity: 0.88 }}
      focusStyle={focusRing(2)}
      style={{ flex: props.flex, opacity: props.disabled ? 0.4 : 1, transform: [{ scale }], borderRadius: small() ? 8 : radius.control }}
    >
      <View
        style={{
          height: small() ? 32 : 44,
          paddingHorizontal: small() ? 12 : 18,
          borderRadius: small() ? 8 : radius.control,
          borderCurve: "continuous",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: small() ? 6 : 8,
          backgroundColor: bg(),
          ...(props.color || variant() === "ghost"
            ? {}
            : variant() === "primary"
              ? finish.light
              : variant() === "accent"
                ? finish.accent
                : finish.raised),
          borderWidth: variant() === "secondary" || variant() === "ghost" ? 1 : 0,
          borderColor: colors.border,
        }}
      >
        <If when={props.icon}>
          <Icon name={props.icon!} size={small() ? 14 : 16} tint={fg()} />
        </If>
        <Text style={{ fontSize: small() ? 13 : 15, fontWeight: "600", color: fg() }}>{props.label}</Text>
      </View>
    </BaseButton>
  );
}

/** A round icon button (44 pt): light by default, `variant="secondary"` dark. */
/** Switches the app between light and dark (`setColorScheme`), whatever the system shows. */
export function ThemeToggle(props: { bar?: boolean }) {
  // In the system's bar (iOS, Android) the system draws the button (iOS's
  // Liquid Glass): the item is the icon alone.
  if (props.bar) {
    return (
      <Press
        onPress={() => setColorScheme(isDark() ? "light" : "dark")}
        scale={0.92}
        accessibilityLabel={isDark() ? "Light appearance" : "Dark appearance"}
      >
        <View style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }}>
          <Icon name={isDark() ? "sun" : "moon"} size={18} tint={colors.text} />
        </View>
      </Press>
    );
  }
  return (
    <RoundButton
      icon={isDark() ? "sun" : "moon"}
      label={isDark() ? "Light appearance" : "Dark appearance"}
      variant="secondary"
      size={34}
      onPress={() => setColorScheme(isDark() ? "light" : "dark")}
    />
  );
}

/** NSH's mark, sharp at any size, in the appearance shown (its dot is dark on light backgrounds). */
export function Logo(props: { size: number }) {
  return <Image src={isDark() ? logoDark : logoLight} style={{ width: props.size, height: props.size }} />;
}

export function RoundButton(props: {
  icon: IconName;
  label: string;
  variant?: "primary" | "secondary";
  size?: number;
  disabled?: boolean;
  onPress: () => void;
}) {
  const size = props.size ?? 44;
  const primary = () => (props.variant ?? "primary") === "primary";
  return (
    <Press onPress={props.onPress} disabled={props.disabled} scale={0.92} accessibilityLabel={props.label}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: primary() ? colors.light : colors.raised,
          ...(primary() ? finish.light : finish.pill),
          borderWidth: primary() ? 0 : 1,
          borderColor: primary() ? colors.border : finish.pill.borderColor,
        }}
      >
        <Icon name={props.icon} size={size * 0.42} tint={primary() ? colors.onLight : colors.text} />
      </View>
    </Press>
  );
}

/** A titled card of controls (the demos' sections). */
export function Section(props: { title: string; note?: string; style?: ViewStyle; children: JSX.Element }) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.card,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          padding: 5,
          ...finish.card,
        },
        props.style ?? null,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", paddingHorizontal: 11, paddingTop: 10, paddingBottom: 10, gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        <If when={props.note}>
          <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text>
        </If>
      </View>
      <Inset>{props.children}</Inset>
    </View>
  );
}

/**
 * An on / off switch (`nsh/base`'s `Switch`, in the gallery's look): the
 * knob springs across, the track changes color natively.
 */
export function Toggle(props: { value: boolean; onChange: (value: boolean) => void; label?: string }) {
  const look = switchLook(() => props.value);
  return (
    <Switch
      checked={props.value}
      onChange={props.onChange}
      accessibilityLabel={props.label}
      // 8 pt more to press on every side (the hit slop of a 30 pt track),
      // without taking more room.
      style={{ margin: -8, padding: 8 }}
      trackStyle={look.trackStyle}
      thumbStyle={look.thumbStyle}
    />
  );
}

/**
 * The gallery's switch, as the styles of `Switch`'s parts: a 50 × 30
 * track that turns citrus and a knob that springs across, both natively.
 * `on` is the value the app owns: the knob follows it, from a press or from
 * elsewhere. `small` is 38 × 22, for pointer-sized rows. Read the styles in
 * JSX, so the appearance is followed.
 */
export function switchLook(on: () => boolean, size: "small" | "regular" = "regular"): { readonly trackStyle: ViewStyle; readonly thumbStyle: ViewStyle } {
  // The track's size and inset, and the knob: it travels what is left inside
  // the border and the padding.
  const [width, height, inset, knob] = size === "small" ? [38, 22, 2, 16] : [50, 30, 3, 22];
  const t = createAnimatedValue(on() ? 1 : 0);
  const x = t.interpolate({ inputRange: [0, 1], outputRange: [0, width - 2 - 2 * inset - knob] });
  let shown = on();
  effect(() => {
    const next = on();
    if (next === shown) return;
    shown = next;
    // Reduced motion: the knob and the track change in place.
    if (reduceMotion()) t.set(next ? 1 : 0);
    else t.spring(next ? 1 : 0, motion.settle);
  });
  return {
    get trackStyle(): ViewStyle {
      return {
        width,
        height,
        borderRadius: height / 2,
        padding: inset,
        backgroundColor: t.interpolate({ inputRange: [0, 1], outputRange: [colors.track, colors.accentFill] }),
        borderWidth: 1,
        borderColor: colors.border,
        ...finish.track,
      };
    },
    get thumbStyle(): ViewStyle {
      return {
        width: knob,
        height: knob,
        borderRadius: knob / 2,
        backgroundColor: on() ? colors.onAccent : colors.knob,
        // A drop of glass: a specular top over the knob's color.
        backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.202) 0%, rgba(255,255,255,0.098) 60%)",
        boxShadow: isDark() ? "inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(0,0,0,0.4)" : finish.knob.boxShadow,
        transform: [{ translateX: x }],
      };
    },
  };
}

/**
 * Equal segments with an indicator that springs to the selected one
 * (`count` shows a quiet number after a label): `nsh/base`'s `Tabs`, a tab
 * per segment, in the gallery's look.
 */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  size?: "small" | "regular";
}) {
  const width = signal(0);
  const x = createAnimatedValue(0);
  const index = () => Math.max(0, props.options.findIndex((o) => o.value === props.value));
  // The track's border and padding: the indicator is placed inside the
  // border (an absolute child's containing block is the padding box), so
  // the segments share what is left of the measured width after both.
  const border = 1;
  const inset = 3;
  const segment = () => (width() - 2 * (border + inset)) / Math.max(1, props.options.length);
  const height = props.size === "small" ? 32 : 40;
  // The first placement jumps; later ones spring.
  let placed = false;
  effect(() => {
    const to = index() * segment();
    if (width() <= 0) return;
    if (placed) x.spring(to, motion.settle);
    else x.set(to);
    placed = true;
  });
  return (
    <Tabs
      onLayout={(e) => width.set(e.size.width)}
      style={{
        height,
        flexDirection: "row",
        padding: inset,
        borderRadius: height / 2,
        backgroundColor: colors.inset,
        boxShadow: finish.track.boxShadow,
        borderWidth: border,
        borderColor: colors.border,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: inset,
          left: inset,
          bottom: inset,
          width: segment(),
          borderRadius: (height - 2 * (border + inset)) / 2,
          ...finish.pill,
          borderWidth: 1,
          transform: [{ translateX: x }],
        }}
      />
      <Each of={props.options}>
        {(option) => (
          <Tab
            selected={props.value === option().value}
            onPress={() => props.onChange(option().value)}
            style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: props.size === "small" ? 13 : 14,
                fontWeight: "500",
                color: props.value === option().value ? colors.text : colors.muted,
              }}
            >
              {option().label}
            </Text>
            <If when={option().count !== undefined}>
              <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{option().count}</Text>
            </If>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}

/** A horizontal meter with an optional marker (a limit). */
export function Meter(props: { value: number; tone?: Tone; marker?: number }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.raised }}>
      <View
        style={{
          width: `${Math.max(0, Math.min(1, props.value)) * 100}%`,
          height: 6,
          borderRadius: 3,
          backgroundColor: toneColor(props.tone ?? "accent"),
        }}
      />
      <If when={props.marker !== undefined}>
        <View style={{ position: "absolute", left: `${(props.marker ?? 0) * 100}%`, top: -3, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.text }} />
      </If>
    </View>
  );
}

/**
 * A demo's page of cards, each fading in after the one before. On phones
 * one column on the 16 pt gutters; in the desktop layout the cards are
 * dealt left to right into as many columns as fit the pane (at least
 * 380 pt each, `columns` at most), on 24 pt gutters. `children` follow the
 * cards inside the scroll view (a demo's modals).
 */
export function DemoPage(props: {
  cards: (() => JSX.Element)[];
  /** The most columns on a desktop (default 2). */
  columns?: number;
  /** Space under the last card on phones (default 40). */
  bottom?: number;
  /** Whether the cards fade in (default true). */
  appear?: boolean;
  keyboardDismissMode?: ScrollProps["keyboardDismissMode"];
  keyboardShouldPersistTaps?: ScrollProps["keyboardShouldPersistTaps"];
  children?: JSX.Element;
}) {
  const card = (Body: () => JSX.Element, index: number) =>
    props.appear === false ? (
      <Body />
    ) : (
      <Appear index={index}>
        <Body />
      </Appear>
    );
  const wide = desktop();
  // Read in the layout below: it is rebuilt only when the count changes.
  const columns = computed(() => columnsFor(380, props.columns ?? 2));
  return (
    <Scroll
      style={{ flex: 1, backgroundColor: colors.background }}
      keyboardDismissMode={props.keyboardDismissMode}
      keyboardShouldPersistTaps={props.keyboardShouldPersistTaps}
    >
      <If
        when={wide}
        else={
          <View style={{ padding: 16, paddingBottom: props.bottom ?? 40, gap: 16 }}>
            <Each of={props.cards}>{(body, i) => card(body(), i())}</Each>
          </View>
        }
      >
        {(() => {
          const n = columns();
          return (
            <View
              style={{ flexDirection: "row", alignItems: "flex-start", gap: 20, padding: 24, paddingBottom: 48, width: "100%", maxWidth: n * 560 + 48, alignSelf: "center" }}
            >
              {Array.from({ length: n }, (_, column) => (
                <View style={{ flex: 1, minWidth: 0, gap: 20 }}>{props.cards.map((body, i) => (i % n === column ? card(body, i) : null))}</View>
              ))}
            </View>
          );
        })()}
      </If>
      {props.children}
    </Scroll>
  );
}

/**
 * A screen whose module loads the first time it is shown: `load` is an
 * `import()` of it. Native bundles hold every module (the import resolves
 * at once); on the web each demo is a chunk of its own, downloaded when
 * opened, so the first load fetches only the index and the demo shown.
 */
export function lazy(load: () => Promise<() => JSX.Element>): () => JSX.Element {
  let screen: (() => JSX.Element) | undefined;
  let loading: Promise<void> | undefined;
  const ready = signal(false);
  const failed = signal("");
  const start = () =>
    (loading ??= load().then(
      (loaded) => {
        screen = loaded;
        ready.set(true);
      },
      (err) => {
        // The next showing tries again.
        loading = undefined;
        failed.set(String(err));
      },
    ));
  function Loaded() {
    const Page = screen!;
    return <Page />;
  }
  return function Lazy() {
    start();
    return (
      <If when={ready()} else={<Loading failed={failed()} />}>
        <Loaded />
      </If>
    );
  };
}

function Loading(props: { failed: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ fontSize: 13, color: props.failed ? colors.danger : colors.faint, textAlign: "center" }}>
        {props.failed || "Loading…"}
      </Text>
    </View>
  );
}

/**
 * A panel at the bottom over a dimmed backdrop while `open` (`nsh/base`'s
 * `Sheet`, in the gallery's look); a press on the backdrop, Escape or the
 * back button closes it (`onClose`: set `open` to false).
 */
export function Sheet(props: { open: boolean; onClose: () => void; children: JSX.Element }) {
  return (
    <BaseSheet
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      popupStyle={{
        gap: 12,
        paddingTop: 8,
        paddingHorizontal: 16,
        paddingBottom: safeArea().bottom + 16,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        backgroundColor: colors.surface,
      }}
    >
      <View style={{ width: 36, height: 5, borderRadius: 3, alignSelf: "center", backgroundColor: colors.raised }} />
      {props.children}
    </BaseSheet>
  );
}
