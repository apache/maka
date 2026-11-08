import type { JSX, ViewStyle } from "nsh";
import { effect, signal, Text, View } from "nsh";
import { reduceMotion } from "nsh";
import { createAnimatedValue } from "nsh";
import { platform } from "nsh";
import { keymap } from "nsh";
import { Button as BaseButton, Sheet as BaseSheet, Switch, Tooltip } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { createPresence, type PopupSide } from "./popup";
import { alpha, colors, finish, focusRing, mono, motion, TERMINAL_COLUMN, TERMINAL_GAP, TERMINAL_ROW, terminal, toneColor, toneTint, type Tone, wholeRows } from "./theme";
import { buttonGlyph, buttonLabel, buttonLook, type ButtonLookOptions, type ButtonSize, roundButtonGlyph, roundButtonLook } from "./look/button";
import { pressSink } from "./look/press";
import { switchLook } from "./look/switch";
import { play } from "./sound";
import { backdrop, sheetGrabber, sheetPanel, tooltipLook, tooltipNote, tooltipText } from "./look/overlay";
import { density, sectionSurface } from "./look/surface";
import { progressFill, progressGlide, progressRail, progressRemaining } from "./look/meter";

export * from "./theme";
export * from "./look/button";
export * from "./look/press";
export * from "./look/switch";
export * from "./look/tool";
export * from "./look/menu";
export * from "./look/overlay";
export * from "./look/surface";
export * from "./look/choice";
export * from "./look/tabs";
export * from "./look/field";
export * from "./look/listbox";
export * from "./look/meter";
export * from "./look/disclosure";
export * from "./look/nav";
export * from "./look/plot";
export * from "./look/workspace";
export * from "./photos";
export { Segmented } from "./segmented";
export * from "./popup";
export * from "./data-table";
export * from "./slider";
export * from "./scrollbar-theme";
export * from "./tree";
export * from "./command";
export * from "./avatar";

/**
 * Instructions for the device's input: `touch` on phones and tablets,
 * `pointer` on desktops (a mouse, a touchpad, a keyboard).
 */
export const hint = (touch: string, pointer: string) => (platform.desktop ? pointer : touch);

/**
 * Desktops' way to refresh what phones pull down (the mouse does not drag
 * scroll views): Ctrl+R / Cmd+R calls `refresh` while the calling component
 * shows, next to the refresh button the demo shows. Browsers keep the key to
 * reload the page, and the development hosts to reload the app. Returns the
 * key's label for the hint, or null where it is not bound.
 */
export function bindRefresh(refresh: () => void): string | null {
  if (!platform.desktop || platform.os === "web") return null;
  keymap.bind("mod+r", refresh);
  return keymap.label("mod+r");
}

/**
 * A pressable that sinks a little while pressed and eases back, natively
 * (`pressSink`: its `activeStyle`, none with reduced motion), so no press
 * waits for JS.
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
  /** Under the pointer (default: a slight dim, whatever its children
   * draw; when the look is on `style`, pass the look's own hover). */
  hoverStyle?: ViewStyle;
  children: JSX.Element;
}) {
  return (
    <View
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={props.disabled}
      hoverStyle={props.disabled ? undefined : (props.hoverStyle ?? { opacity: 0.86 })}
      activeStyle={props.disabled ? undefined : pressSink(props.scale).activeStyle}
      role={props.role ?? "button"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.accessibilityState}
      hitSlop={props.hitSlop}
      style={[props.style ?? null, { ...pressSink().transition, opacity: props.disabled ? 0.4 : 1 }]}
      focusStyle={focusRing()}
    >
      {props.children}
    </View>
  );
}

/**
 * `Press`'s feedback for a `Tab` of `nsh/base`: it sinks a little while
 * pressed and eases back (`pressSink`), and takes presses 4 pt around it
 * without taking more room (a hit slop). Spread `style` and `activeStyle`
 * into the tab's.
 */
export const tabPress = {
  style: { margin: -4, padding: 4, ...pressSink().transition },
  get activeStyle(): ViewStyle {
    return pressSink().activeStyle;
  },
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

/** A rounded icon tile (decoration: none in the terminal). */
export function IconTile(props: { name: IconName; tint?: string; size?: number }) {
  if (terminal) return null;
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

/** A pointer and a keyboard: the compact sizes of desktops. */
const pointer = platform.desktop;

/**
 * A section's title and what it shows, above its surface: 13 pt semibold on
 * a desktop, 15 on a touch screen, `right` at the trailing
 * edge (a badge, an action).
 */
function SectionHead(props: { title: string; subtitle?: JSX.Element; right?: JSX.Element }) {
  // The terminal's subtitle takes the section's width under the title row:
  // a trailing action shares the title's row, never the subtitle's. Set in
  // by a column, the head lines up with the frame's content under it, and
  // its action keeps clear of the next section's title.
  if (terminal) {
    return (
      <View style={{ paddingHorizontal: TERMINAL_COLUMN }}>
        <View style={{ flexDirection: "row", gap: TERMINAL_GAP }}>
          <Text style={{ flex: 1, fontSize: density.title, fontWeight: "600", color: colors.text }}>{props.title}</Text>
          {props.right}
        </View>
        <If when={props.subtitle}>
          <Text style={{ fontSize: density.note, color: colors.muted }}>{props.subtitle}</Text>
        </If>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: pointer ? 2 : 4 }}>
      <View style={{ flex: 1, gap: terminal ? 0 : 2 }}>
        <Text
          style={
            pointer
              ? { fontSize: density.title, fontWeight: "600", color: colors.text }
              : { fontSize: 15, fontWeight: "600", color: colors.text }
          }
        >
          {props.title}
        </Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: density.note, color: colors.muted }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/**
 * The one section shown, by its title in any case (null: all of them): the
 * gallery sets it from `cargo run -- <demo> --section <title>`, so a check
 * or a screenshot opens straight at a section instead of scrolling to it.
 */
export const focusedSection = signal<string | null>(null);

/**
 * A section of a demo: its title and subtitle above, then one flat surface
 * holding the content, padded (or bare with `flush`, for rows and stages that
 * reach its edges). `icon` names what it shows for callers that list it; the
 * section itself draws none. The terminal puts the title right above the box
 * and the content one Cell inside it.
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
    <If when={focusedSection() == null || focusedSection()!.toLowerCase() === props.title?.toLowerCase()}>
    <View style={[{ gap: terminal ? 0 : 8 }, props.style ?? null]}>
      <If when={props.title}>
        <SectionHead title={props.title!} subtitle={props.subtitle} right={props.right} />
      </If>
      {/* The flat surface (`sectionSurface`), clipping what reaches its edges. */}
      <View style={{ ...sectionSurface(), overflow: terminal ? undefined : "hidden" }}>
        <If when={!props.flush} else={props.children}>
          <Inset>{props.children}</Inset>
        </If>
      </View>
    </View>
    </If>
  );
}

/**
 * A section's content area: padded and spaced, on the surface it sits on
 * (no surface of its own, so sections never nest boxes); in the terminal
 * only its gap, in whole rows.
 */
export function Inset(props: { gap?: number; padding?: number; children: JSX.Element }) {
  if (terminal) return <View style={{ gap: wholeRows(props.gap ?? density.gap) }}>{props.children}</View>;
  return <View style={{ padding: props.padding ?? density.pad, gap: props.gap ?? density.gap }}>{props.children}</View>;
}

/** A caption row: a label on the left, a quieter note on the right. */
export function Caption(props: { label: JSX.Element; note?: JSX.Element }) {
  return (
    // The terminal keeps the note two columns from the label it follows.
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: terminal ? TERMINAL_GAP : 8 }}>
      <Text style={{ flex: 1, fontSize: density.body, color: colors.muted }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: density.note, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text>
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

/** A small label in a tinted capsule (a word on its row in the terminal). */
export function Badge(props: { label: string; tone?: Tone; outline?: boolean }) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View
      style={{
        paddingHorizontal: terminal ? 0 : 10,
        height: terminal ? TERMINAL_ROW : 26,
        borderRadius: 13,
        justifyContent: "center",
        backgroundColor: props.outline ? "transparent" : toneTint(tone()),
        boxShadow: props.outline ? undefined : finish.chip.boxShadow,
        borderWidth: 1,
        borderColor: props.outline ? toneColor(tone()) : alpha(tone() === "neutral" ? colors.text : toneColor(tone()), 0.1),
        // A change of tone (a window turning active) crosses over.
        transitionProperty: "colors",
        transitionDuration: 160,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "500", color: tone() === "neutral" ? colors.text : toneColor(tone()) }}>{props.label}</Text>
    </View>
  );
}

/** A state in a list row or a header, quieter than a `Badge`: a round dot
 * and a word, tinted only for a tone that matters (an active window); the
 * dot's color crosses over as the state changes. The word alone in the
 * terminal. */
export function Status(props: { label: string; tone?: Tone }) {
  const tinted = () => props.tone != null && props.tone !== "neutral";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <If when={!terminal}>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 3.5,
            backgroundColor: tinted() ? toneColor(props.tone!) : colors.faint,
            transitionProperty: "colors",
            transitionDuration: 160,
          }}
        />
      </If>
      <Text style={{ fontSize: 12, fontWeight: tinted() ? "500" : "400", color: tinted() ? toneColor(props.tone!) : colors.muted, numberOfLines: 1 }}>
        {props.label}
      </Text>
    </View>
  );
}

/** A label above a value, for grids of figures; on one row in the terminal,
 * the value right-aligned. `truncate` keeps a value that may run long (a
 * display's name) on its one line, ending in an ellipsis. */
export function Stat(props: { label: string; value: string; tone?: Tone; width?: `${number}%`; truncate?: boolean }) {
  // The label above its value in the terminal too: two rows, so stats set
  // side by side keep apart and each value stays under its label.
  return (
    <View
      style={
        terminal
          ? { width: props.width }
          : { width: props.width, gap: 3, paddingVertical: 4 }
      }
    >
      <Text style={{ fontSize: 12, color: colors.muted }}>{props.label}</Text>
      <Text
        style={{
          fontSize: 15,
          color: props.tone ? toneColor(props.tone) : colors.text,
          fontVariant: ["tabular-nums"],
          numberOfLines: props.truncate ? 1 : undefined,
          paddingRight: props.truncate && !terminal ? 8 : undefined,
        }}
      >
        {props.value}
      </Text>
    </View>
  );
}

/** A colored square and a label, for chart legends (the label alone in the
 * terminal, which draws no charts). */
export function Legend(props: { color: string; label: string; value?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <If when={!terminal}>
        <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: props.color }} />
      </If>
      <Text style={{ fontSize: 13, color: colors.muted }}>
        {props.label}
        <If when={props.value}>
          <Text style={{ color: colors.text, fontVariant: ["tabular-nums"] }}> {props.value}</Text>
        </If>
      </Text>
    </View>
  );
}

/** A row inside an inset, with a hairline above all but the first (one row
 * of the terminal, which keeps no hairlines between rows). */
/** A row of a list card. `focusable` makes it a stop of the keyboard focus
 * that shows the focus ring (a row that is a `ContextMenu`'s trigger, which
 * Shift+F10 and the Menu key open). */
export function Row(props: { first?: boolean; focusable?: boolean; onPress?: () => void; children: JSX.Element }) {
  return (
    <View
      onPress={props.onPress}
      focusable={props.focusable}
      focusStyle={props.focusable ? focusRing() : undefined}
      activeStyle={props.onPress ? { backgroundColor: colors.raised } : undefined}
      style={{
        minHeight: terminal ? TERMINAL_ROW : density.row,
        // Room above and below for two-line rows (a title and a note) and
        // their icon tiles, so nothing touches the lines between rows.
        paddingVertical: terminal ? 0 : 8,
        flexDirection: "row",
        alignItems: "center",
        gap: terminal ? TERMINAL_GAP : 12,
        borderTopWidth: props.first || terminal ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      {props.children}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "accent" | "ghost" | "danger";

/** A ring turning with its top arc in `tint`: work going on. */
export function Spinner(props: { size: number; tint: string }) {
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        borderWidth: Math.max(1.5, props.size / 8),
        borderColor: alpha(props.tint, 0.25),
        borderTopColor: props.tint,
        animationName: "spin",
        animationDuration: 800,
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
      }}
    />
  );
}

/**
 * A button (`buttonLook`'s, on `nsh/base`'s `Button`): 28 pt tall on a
 * desktop, 40 on a touch screen (`small` 24 / 36, `large` 34 / 48); one
 * row, its label and no glyph in the terminal, which brackets it.
 * `primary` and `accent` are the citrus fill (the main action),
 * `secondary` a raised neutral, `ghost` bare until the pointer is over it
 * (in the terminal, `ghostFill`'s faint band), `danger` a destructive
 * action: the danger tone's tint, edge and text on the raised finish's
 * drop, as quiet as `secondary`. Under the pointer a raised button
 * lightens; pressed it sinks (an inner shade, and 3% smaller, natively:
 * `activeStyle`). `busy` puts a spinner in the icon's place and takes no
 * presses; a new icon or the spinner grows in. Its width follows the label
 * at once: a layout animation would move every frame of the update,
 * app-wide (a list refreshing beside it too), so the motion stays on the
 * glyph's own opacity and scale.
 */
export function Button(props: {
  label: string;
  /** What screen readers say, when the label is shorter (default `label`). */
  accessibilityLabel?: string;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  /** Work started by it is going on: a spinner, no presses (not dimmed). */
  busy?: boolean;
  /** Grows to share a row with its siblings. */
  flex?: number;
  size?: ButtonSize;
  /** Shown as chosen: what it opens is open (a menu's or a popover's
   * trigger), or the current one of a few. A ghost button keeps the hover's
   * `accent` fill, a raised one the `on` fill, a filled one its pressed shade. */
  selected?: boolean;
  onPress: () => void;
}) {
  // `nsh/base`'s Button gives the behavior (presses, disabled, the button
  // role); the look is `buttonLook`'s.
  const options: ButtonLookOptions = {
    size: () => props.size,
    selected: () => props.selected,
    disabled: () => props.disabled,
    busy: () => props.busy,
    style: () => (props.flex === undefined ? undefined : { flex: props.flex }),
  };
  const variant = () => props.variant ?? "primary";
  const look = buttonLook(variant, options);
  const glyphLook = buttonGlyph(variant, options);
  // The leading glyph (the icon, or the spinner while busy) grows in each
  // time it changes; at once with reduced motion.
  const glyph = createAnimatedValue(1);
  let shownGlyph = props.busy ? "busy" : props.icon;
  effect(() => {
    const next = props.busy ? "busy" : props.icon;
    if (next === shownGlyph) return;
    shownGlyph = next;
    if (reduceMotion()) return;
    glyph.set(0);
    glyph.spring(1, motion.control);
  });
  return (
    <BaseButton
      // Busy, it keeps its focus and its look and takes no second press.
      onPress={() => !props.busy && props.onPress()}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      selected={props.selected}
      {...look}
    >
      <If when={(props.busy || props.icon) && !terminal}>
        <View style={{ opacity: glyph, transform: [{ scale: glyph.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }] }}>
          <If when={props.busy} else={<Icon name={props.icon!} {...glyphLook} />}>
            <Spinner {...glyphLook} />
          </If>
        </View>
      </If>
      <Text style={buttonLabel(variant, options)}>{props.label}</Text>
    </BaseButton>
  );
}

/**
 * A round icon button (`roundButtonLook`'s); in the terminal a text button
 * reading `title` (a word or two), else `label`.
 */
export function RoundButton(props: {
  icon: IconName;
  label: string;
  /** The terminal's text in place of the icon (default `label`). */
  title?: string;
  variant?: "primary" | "secondary";
  size?: number;
  disabled?: boolean;
  onPress: () => void;
}) {
  if (terminal) {
    return (
      <Button
        label={props.title ?? props.label}
        accessibilityLabel={props.label}
        variant={props.variant ?? "primary"}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  }
  const variant = props.variant ?? "primary";
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      {...roundButtonLook(variant, { size: props.size, disabled: () => props.disabled })}
    >
      <Icon name={props.icon} {...roundButtonGlyph(variant, props.size)} />
    </BaseButton>
  );
}

/** A titled section of controls (the demos' sections): `Card`'s look, `note` at its trailing edge. */
export function Section(props: { title: string; note?: string; style?: ViewStyle; children: JSX.Element }) {
  return (
    <Card
      title={props.title}
      right={
        props.note ? <Text style={{ fontSize: density.note, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text> : undefined
      }
      style={props.style}
    >
      {props.children}
    </Card>
  );
}

/**
 * An on / off switch (`nsh/base`'s `Switch`, in the gallery's look): the
 * knob springs across, the track changes color natively, and it sounds
 * `toggle`, a little lower turning off.
 */
export function Toggle(props: { value: boolean; onChange: (value: boolean) => void; label?: string }) {
  const look = switchLook(() => props.value);
  return (
    <Switch
      checked={props.value}
      onChange={({ checked }) => {
        play("toggle", { rate: checked ? 1 : 0.9 });
        props.onChange(checked);
      }}
      accessibilityLabel={props.label}
      // 8 pt more to press on every side (a hit slop around the small
      // track), without taking more room.
      style={{ margin: -8, padding: 8 }}
      trackStyle={look.trackStyle}
      thumbStyle={look.thumbStyle}
    />
  );
}

/** A horizontal meter with an optional marker (a limit), `value` from 0
 * to 1: a progress bar's rail and fill (`look/meter.ts`), the fill gliding
 * to each new value; half a row in the terminal, so its fill is a solid bar
 * rather than a rule. */
export function Meter(props: { value: number; tone?: Tone; marker?: number }) {
  return (
    // The marker stands past the rail, which clips its fill: they sit side
    // by side in a view of the rail's height.
    <View style={{ height: terminal ? TERMINAL_ROW / 2 : 6 }}>
      {terminal ? (
        <View style={{ height: TERMINAL_ROW / 2, backgroundColor: colors.track }}>
          <View style={{ width: `${Math.max(0, Math.min(1, props.value)) * 100}%`, height: TERMINAL_ROW / 2, backgroundColor: props.tone && props.tone !== "accent" ? toneColor(props.tone) : colors.accentFill }} />
        </View>
      ) : (
        <View style={progressRail(6)}>
          <View class={progressGlide} style={{ ...progressFill(6, props.tone), translate: progressRemaining(props.value * 100) }} />
        </View>
      )}
      <If when={props.marker !== undefined}>
        <View style={{ position: "absolute", left: `${(props.marker ?? 0) * 100}%`, top: -4, width: 2, height: 12, borderRadius: 1, backgroundColor: colors.text }} />
      </If>
    </View>
  );
}

/**
 * A panel at the bottom over a dimmed backdrop while `open` (`nsh/base`'s
 * `Sheet`, in the gallery's look: `sheetPanel("bottom")` with its
 * `sheetGrabber`, over `backdrop()`); a press on the backdrop, Escape or
 * the back button closes it (`onClose`: set `open` to false). It comes in
 * with `open` and goes with `close`, quietly.
 */
export function Sheet(props: { open: boolean; onClose: () => void; children: JSX.Element }) {
  let was = props.open;
  effect(() => {
    const open = props.open;
    if (open !== was) play(open ? "open" : "close", { volume: 0.45 });
    was = open;
  });
  return (
    <BaseSheet open={props.open} onOpenChange={({ open }) => !open && props.onClose()} backdropStyle={backdrop()} popupStyle={sheetPanel("bottom")}>
      <View style={sheetGrabber()} />
      {props.children}
    </BaseSheet>
  );
}

export { Icon, IconLabel, type IconName } from "./icons";

/**
 * A short text as an element's `tooltip`: a `Tooltip` of `nsh/base` in a
 * small bubble of the theme's `popover` tokens (`tooltipLook`) that comes in with `popIn`
 * from its side (`placement`, default above), with the keys of a
 * `shortcut` after the text. In the terminal the tooltip is a line of the
 * status line: the text and its keys, no bubble.
 */
export function Tip(props: { label: string; shortcut?: string; placement?: PopupSide; delay?: number }) {
  if (terminal) {
    return (
      <Tooltip delay={props.delay}>
        <View style={{ flexDirection: "row", gap: TERMINAL_COLUMN, paddingHorizontal: TERMINAL_COLUMN }}>
          <Text class="text-foreground">{props.label}</Text>
          <If when={props.shortcut}>
            <Text class="text-muted-foreground">{props.shortcut}</Text>
          </If>
        </View>
      </Tooltip>
    );
  }
  const presence = createPresence(props.placement ?? "top");
  return (
    <Tooltip placement={props.placement} delay={props.delay} onOpen={presence.show} onClose={presence.hide}>
      <View class={tooltipLook().class} style={presence.style}>
        <Text class={tooltipText}>{props.label}</Text>
        <If when={props.shortcut}>
          <Text class={tooltipNote} style={{ fontVariant: ["tabular-nums"] }}>
            {props.shortcut}
          </Text>
        </If>
      </View>
    </Tooltip>
  );
}
