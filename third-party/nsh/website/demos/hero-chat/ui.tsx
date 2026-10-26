import type { JSX, ViewStyle } from "nsh";
import { effect, signal, Text, View } from "nsh";
import { colorScheme } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { Icon, type IconName } from "./icons";

/** Whether the gallery shows its dark palette (reactive: reading it subscribes). */
export const isDark = () => colorScheme() !== "light";

/**
 * An object with `dark`'s keys whose getters read `dark` or `light` by the
 * appearance shown: every read in a reactive scope (JSX, a `draw`, an
 * effect) follows appearance changes, and spreads into components keep the
 * getters.
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

/**
 * The gallery's look: a graphite page (or a paper one in light
 * appearance), cards with an inset surface, tabular numbers and one citrus
 * accent. Sizes are for phones: 16 pt gutters, 44 pt touch targets, 15 pt
 * body text.
 */
export const colors: Palette = themed<Palette>(
  {
    background: "#101113",
    surface: "#18191c",
    inset: "#0c0d0f",
    raised: "#24262a",
    border: "#2c2e33",
    line: "#24262a",
    text: "#eceef1",
    muted: "#8d9198",
    faint: "#5a5e65",
    accent: "#c8f26d",
    accentFill: "#c8f26d",
    onAccent: "#13160c",
    light: "#eef0f2",
    onLight: "#111214",
    track: "#24262a",
    knob: "#8d9198",
    code: "#d9dde3",
    info: "#7ea8ff",
    warn: "#ffb547",
    danger: "#ff6170",
    up: "#45d49a",
    down: "#ff6170",
  },
  {
    background: "#f4f4f2",
    surface: "#ffffff",
    inset: "#f0f0ec",
    raised: "#fbfbf9",
    border: "#d8d8d1",
    line: "#e2e2dc",
    text: "#16171a",
    muted: "#5f636a",
    faint: "#9a9ea4",
    accent: "#4f6e0c",
    accentFill: "#c8f26d",
    onAccent: "#13160c",
    light: "#16171a",
    onLight: "#ffffff",
    track: "#e2e2dd",
    knob: "#ffffff",
    code: "#2a2d33",
    info: "#3d63d1",
    warn: "#b26a00",
    danger: "#d43a4a",
    up: "#138a5a",
    down: "#d43a4a",
  },
);

/** `rgba()` of a `#rrggbb` color. */
export function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Translucent tints of the tones, for fills behind text. */
export const tints = themed(
  {
    accent: "rgba(200,242,109,0.14)",
    info: "rgba(126,168,255,0.16)",
    warn: "rgba(255,181,71,0.16)",
    danger: "rgba(255,97,112,0.16)",
    up: "rgba(69,212,154,0.16)",
    down: "rgba(255,97,112,0.16)",
  },
  {
    accent: "rgba(124,170,20,0.14)",
    info: "rgba(61,99,209,0.10)",
    warn: "rgba(178,106,0,0.11)",
    danger: "rgba(212,58,74,0.10)",
    up: "rgba(19,138,90,0.10)",
    down: "rgba(212,58,74,0.10)",
  },
);

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
export const finish = themed<Record<"card" | "inset" | "raised" | "light" | "accent" | "track" | "knob" | "pill" | "chip" | "glass" | "menu", Finish>>(
  {
    card: {
      backgroundImage: "linear-gradient(180deg, #1b1c20 0%, #191a1d 100%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 16px 36px -20px rgba(0,0,0,0.75)",
    },
    inset: { boxShadow: "inset 0 1px 3px rgba(0,0,0,0.55)" },
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
export const radius = { card: 16, inset: 12, control: 10 } as const;

/** Header props of every screen. */
export const header = {
  get headerBackgroundColor() {
    return colors.background;
  },
  get headerTitleColor() {
    return colors.text;
  },
  get headerTintColor() {
    return colors.accent;
  },
};

/** The motion every control shares: quick, slightly springy. */
export const motion = {
  press: { stiffness: 520, damping: 34 },
  settle: { stiffness: 320, damping: 30 },
  enter: { duration: 420, easing: Easing.out(Easing.cubic) },
} as const;

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
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean; expanded?: boolean };
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
      activeStyle={{ backgroundColor: props.onPress ? colors.raised : undefined }}
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
 * A button, 44 pt tall: `primary` is light (the main action), `secondary`
 * dark, `accent` citrus. A `color` fills it with that color instead.
 */
export function Button(props: {
  label: string;
  variant?: ButtonVariant;
  color?: string;
  icon?: IconName;
  disabled?: boolean;
  /** Grows to share a row with its siblings. */
  flex?: number;
  onPress: () => void;
}) {
  const variant = () => props.variant ?? "primary";
  const bg = () =>
    props.color ?? (variant() === "primary" ? colors.light : variant() === "accent" ? colors.accentFill : variant() === "ghost" ? "transparent" : colors.raised);
  const fg = () => (props.color ? "#ffffff" : variant() === "primary" ? colors.onLight : variant() === "accent" ? colors.onAccent : colors.text);
  return (
    <Press onPress={props.onPress} disabled={props.disabled} accessibilityLabel={props.label} style={props.flex ? { flex: props.flex } : undefined}>
      <View
        style={{
          height: 44,
          paddingHorizontal: 18,
          borderRadius: radius.control,
          borderCurve: "continuous",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
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
          <Icon name={props.icon!} size={16} tint={fg()} />
        </If>
        <Text style={{ fontSize: 15, fontWeight: "600", color: fg() }}>{props.label}</Text>
      </View>
    </Press>
  );
}

/** A round icon button (44 pt): light by default, `variant="secondary"` dark. */
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

/** An on / off switch: the knob springs across, the track changes color natively. */
export function Toggle(props: { value: boolean; onChange: (value: boolean) => void; label?: string }) {
  const t = createAnimatedValue(props.value ? 1 : 0);
  let last = props.value;
  return (
    <View
      onPress={() => {
        last = !props.value;
        t.spring(last ? 1 : 0, motion.settle);
        props.onChange(last);
      }}
      role="switch"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.value }}
      hitSlop={8}
      style={{
        width: 50,
        height: 30,
        borderRadius: 15,
        padding: 3,
        backgroundColor: t.interpolate({ inputRange: [0, 1], outputRange: [colors.track, colors.accentFill] }),
        borderWidth: 1,
        borderColor: colors.border,
        ...finish.track,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: props.value ? colors.onAccent : colors.knob,
          // A drop of glass: a specular top over the knob's color.
          backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.202) 0%, rgba(255,255,255,0.098) 60%)",
          boxShadow: isDark() ? "inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(0,0,0,0.4)" : finish.knob.boxShadow,
          transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }],
        }}
      />
    </View>
  );
}

/**
 * Equal segments with an indicator that springs to the selected one
 * (`count` shows a quiet number after a label).
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
  const segment = () => (width() - 6) / Math.max(1, props.options.length);
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
    <View
      onLayout={(e) => width.set(e.size.width)}
      role="tablist"
      style={{
        height,
        flexDirection: "row",
        padding: 3,
        borderRadius: height / 2,
        backgroundColor: colors.inset,
        boxShadow: finish.track.boxShadow,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 3,
          left: 3,
          bottom: 3,
          width: segment(),
          borderRadius: (height - 6) / 2,
          ...finish.pill,
          borderWidth: 1,
          transform: [{ translateX: x }],
        }}
      />
      <Each of={props.options}>
        {(option) => (
          <View
            onPress={() => props.onChange(option().value)}
            role="tab"
            accessibilityState={{ selected: props.value === option().value }}
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
          </View>
        )}
      </Each>
    </View>
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

