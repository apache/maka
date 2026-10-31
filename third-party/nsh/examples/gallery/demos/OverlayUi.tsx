// The parts the overlay demos share (Popover, Tooltip, Sheet, Toast): a
// trigger with an icon, a text field, an avatar and the log of events, in
// the gallery's look.
import { createAnimatedValue, type JSX, platform, signal, split, Text, token, View } from "nsh";
import { Input, type InputProps } from "nsh/base";
import { LucideIcon, type LucideIconName } from "../icons";
import { alpha, Caption, Card, colors, finish, focusRing, hovered, mono, radius, toneColor, toneTint, type Tone } from "../ui";

/** A pointer and a keyboard: desktop density. */
export const pointer = platform.desktop;

/** A tap or a click, as the device says it. */
export const tap = pointer ? "Click" : "Tap";

/**
 * What opens a popup, as the gallery's `Button` looks (`secondary` raised,
 * `ghost` bare until the pointer is over it, `primary` the citrus fill) but
 * a plain view: the popup's trigger slot takes its presses and anchors to
 * it. While what it opens is open (`open`) it shows as selected; pressed
 * it sinks. With `onPress` it is a button of its own (a toolbar's), `tip`
 * its tooltip, `ink` its icon's and label's color.
 */
export function Trigger(props: {
  label?: string;
  icon?: LucideIconName;
  open?: boolean;
  variant?: "secondary" | "ghost" | "primary";
  ink?: string;
  accessibilityLabel?: string;
  tip?: JSX.Element;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const variant = () => props.variant ?? "secondary";
  const look = () =>
    variant() === "primary"
      ? { ...finish.accent, opacity: props.open ? 0.88 : 1 }
      : variant() === "ghost"
        ? { backgroundColor: props.open ? token("accent") : "transparent", borderColor: "transparent" }
        : props.open
          ? finish.pressed
          : finish.raised;
  const ink = () => props.ink ?? (variant() === "primary" ? colors.onAccent : variant() === "ghost" ? colors.muted : colors.text);
  return (
    <View
      role={props.onPress ? "button" : undefined}
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={props.onPress && props.open !== undefined ? { selected: props.open } : undefined}
      tooltip={props.tip}
      hoverStyle={props.open || props.disabled ? undefined : variant() === "primary" ? { opacity: 0.94 } : variant() === "ghost" ? hovered() : finish.hover}
      activeStyle={{ ...(variant() === "primary" ? { opacity: 0.88 } : variant() === "ghost" ? { backgroundColor: alpha(colors.text, 0.09) } : finish.pressed), transform: [{ scale: 0.97 }] }}
      focusStyle={focusRing()}
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: pointer ? 6 : 8,
        height: pointer ? 28 : 40,
        minWidth: pointer ? 28 : 40,
        paddingHorizontal: props.label ? (pointer ? 10 : 14) : 0,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        opacity: props.disabled ? 0.4 : 1,
        ...look(),
        transitionProperty: "background-color, border-color, box-shadow, opacity, transform",
        transitionDuration: 120,
      }}
    >
      <If when={props.icon}>
        <LucideIcon name={props.icon!} size={pointer ? 14 : 17} tint={ink()} />
      </If>
      <If when={props.label}>
        <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: ink() }}>{props.label}</Text>
      </If>
    </View>
  );
}

/**
 * A one-line text field: a well below the surface it sits on, an accent
 * ring that fades in around it while it has the keyboard, `prefix` before
 * the text.
 */
export function Field(props: InputProps & { prefix?: string }) {
  const [own, input] = split(props, ["prefix", "onFocus", "onBlur", "style"]);
  const focus = createAnimatedValue(0);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: props.multiline ? "flex-start" : "center",
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.fieldBorder,
        backgroundColor: colors.field,
        ...finish.field,
      }}
    >
      <If when={own.prefix}>
        <Text style={{ paddingLeft: pointer ? 8 : 12, fontSize: pointer ? 13 : 15, color: colors.faint }}>{own.prefix}</Text>
      </If>
      <Input
        {...input}
        onFocus={() => {
          focus.timing(1, { duration: 160 });
          own.onFocus?.();
        }}
        onBlur={() => {
          focus.timing(0, { duration: 220 });
          own.onBlur?.();
        }}
        style={[
          {
            flex: 1,
            paddingHorizontal: own.prefix ? 2 : pointer ? 8 : 12,
            fontSize: pointer ? 13 : 15,
            color: colors.text,
            placeholderColor: colors.faint,
            caretColor: colors.accent,
            selectionColor: colors.accent,
            ...(props.multiline ? { minHeight: pointer ? 56 : 84, paddingTop: pointer ? 6 : 12, paddingBottom: pointer ? 6 : 12 } : { height: pointer ? 28 : 40 }),
          },
          ...(Array.isArray(own.style) ? own.style : [own.style]),
        ]}
      />
      <View
        style={{
          pointerEvents: "none",
          position: "absolute",
          top: -1,
          left: -1,
          right: -1,
          bottom: -1,
          borderRadius: radius.control + 1,
          borderCurve: "continuous",
          borderWidth: 2,
          borderColor: colors.accent,
          opacity: focus,
        }}
      />
    </View>
  );
}

/** The tones avatars take, by name: one person keeps one color. */
const avatarTones: Tone[] = ["accent", "info", "up", "warn", "danger"];

/** A person's initials on a disc of a tone their name picks. */
export function Avatar(props: { name: string; size?: number }) {
  const size = () => props.size ?? (pointer ? 28 : 36);
  const tone = () => avatarTones[[...props.name].reduce((n, c) => n + c.charCodeAt(0), 0) % avatarTones.length];
  const initials = () =>
    props.name
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  return (
    <View
      style={{
        width: size(),
        height: size(),
        borderRadius: size() / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: toneTint(tone()),
        borderWidth: 1,
        borderColor: alpha(toneColor(tone()), 0.25),
      }}
    >
      <Text style={{ fontSize: size() * 0.38, fontWeight: "600", color: toneColor(tone()) }}>{initials()}</Text>
    </View>
  );
}

/** A thin rule across a popup or a sheet. */
export function Rule() {
  return <View style={{ height: 1, marginHorizontal: -4, backgroundColor: colors.line }} />;
}

/**
 * The events a demo reports (`onOpenChange` with its reason, what was
 * chosen), newest first: `log` adds one, `Events` is the section that
 * lists them.
 */
export function createEvents(empty: string) {
  const events = signal<string[]>([]);
  const log = (what: string) => events.set([what, ...events()].slice(0, 6));
  function Events() {
    return (
      <Card icon="system" title="Events" subtitle="onOpenChange with its reason, and what was done">
        <If when={events().length > 0} else={<Caption label={empty} />}>
          <View style={{ gap: 4 }}>
            <Each of={events()}>
              {(e, i) => <Text style={{ fontSize: 12, fontFamily: mono, color: i() === 0 ? colors.text : colors.faint }}>{e()}</Text>}
            </Each>
          </View>
        </If>
      </Card>
    );
  }
  return { log, Events };
}
