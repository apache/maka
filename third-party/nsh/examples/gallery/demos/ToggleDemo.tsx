import { Canvas, createAnimatedValue, Easing, effect, type JSX, LayoutAnimation, Path2D, platform, reduceMotion, signal, Text, View, type ViewStyle } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";
import { alpha, Badge, Caption, Card, chart, colors, DemoPage, finish, focusRing, hovered, mono, motion, Toggle as Switch } from "../ui";
import { LucideIcon, type LucideIconName } from "./RichEditorUi";

// `nsh/base`'s `Toggle` owns presses, the pressed state screen readers hear
// (a toggle button), keyboard focus and the disabled state; `ToggleGroup`
// makes a toolbar of them, one Tab stop whose arrow keys move the focus.
// Which toggles are pressed is the app's: any number (bold, italic), or
// exactly one (an alignment, a view). The look and the motion are the
// gallery's: a raised pill while pressed that fades in, a press that sinks,
// a star that pops; none of it with reduced motion.

const pointer = platform.desktop;

type Size = "small" | "regular" | "large";

/** A toggle's side and its icon's, by size: compact with a pointer, roomier on a touch screen. */
const SIZES: Record<Size, { side: number; icon: number; text: number; pad: number }> = pointer
  ? { small: { side: 24, icon: 14, text: 12, pad: 8 }, regular: { side: 28, icon: 16, text: 13, pad: 10 }, large: { side: 34, icon: 18, text: 14, pad: 12 } }
  : { small: { side: 32, icon: 16, text: 13, pad: 10 }, regular: { side: 38, icon: 18, text: 15, pad: 12 }, large: { side: 44, icon: 20, text: 16, pad: 14 } };

/** The fades and the sink every toggle shares; nothing moves with reduced motion. */
const transition = (): ViewStyle => ({
  transitionProperty: "background-color, border-color, box-shadow, transform, opacity",
  transitionDuration: reduceMotion() ? 0 : 140,
  transitionTimingFunction: "ease-out",
});

/** What a toggle shows: a Lucide icon, a glyph drawn here, and a label after it. */
type Content = { icon?: LucideIconName; glyph?: (tint: string, size: number) => JSX.Element; text?: string };

/**
 * A toolbar toggle in the gallery's look: bare (`ghost`) or on a field's
 * edge (`outline`) while off, the raised pill while pressed; the pointer's
 * hover and the focus ring as every control's. Its label is what screen
 * readers say and, with a pointer, its tooltip.
 */
function Tool(props: Content & {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  disabled?: boolean;
  size?: Size;
  variant?: "ghost" | "outline";
}) {
  const s = () => SIZES[props.size ?? "regular"];
  const tint = () => (props.pressed ? colors.text : colors.muted);
  const outline = () => props.variant === "outline";
  return (
    <View tooltip={props.text ? undefined : props.label}>
      <Toggle
        pressed={props.pressed}
        disabled={props.disabled}
        accessibilityLabel={props.label}
        onChange={({ pressed }) => props.onChange(pressed)}
        style={{
          minWidth: s().side,
          height: s().side,
          paddingHorizontal: props.text ? s().pad : 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          borderRadius: s().side / 4 + 1,
          borderCurve: "continuous",
          borderWidth: 1,
          ...(outline() ? { borderColor: colors.fieldBorder, backgroundColor: colors.field } : { borderColor: "transparent" }),
          ...transition(),
        }}
        pressedStyle={{ ...finish.pill }}
        hoverStyle={props.pressed || props.disabled ? undefined : hovered()}
        activeStyle={{ transform: [{ scale: 0.92 }] }}
        focusStyle={focusRing(1)}
        disabledStyle={{ opacity: 0.4 }}
      >
        <If when={props.icon}>
          <LucideIcon name={props.icon!} size={s().icon} tint={tint()} />
        </If>
        <If when={props.glyph}>{props.glyph!(tint(), s().icon)}</If>
        <If when={props.text}>
          <Text style={{ fontSize: s().text, fontWeight: "500", color: tint() }}>{props.text}</Text>
        </If>
      </Toggle>
    </View>
  );
}

type Align = "left" | "center" | "right" | "justify";

/** Four lines of a paragraph, set as `align` sets them, on Lucide's grid and pen. */
function AlignGlyph(props: { align: Align; tint: string; size: number }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: props.size, height: props.size }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        [16, 10, 14, 8].forEach((w, i) => {
          const len = props.align === "justify" ? 16 : w;
          const x = props.align === "center" ? 12 - len / 2 : props.align === "right" ? 20 - len : 4;
          cx.beginPath();
          cx.moveTo(x, 6 + i * 4);
          cx.lineTo(x + len, 6 + i * 4);
          cx.stroke();
        });
      }}
    />
  );
}

/** Four tiles, a grid's glyph, on Lucide's grid and pen. */
function GridGlyph(props: { tint: string; size: number }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: props.size, height: props.size }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 2;
        cx.lineJoin = "round";
        for (const [x, y] of [[3, 3], [14, 3], [3, 14], [14, 14]]) {
          cx.beginPath();
          cx.roundRect(x, y, 7, 7, 1.5);
          cx.stroke();
        }
      }}
    />
  );
}

const STAR = new Path2D(
  "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
);

/** Lucide's star: outlined, or filled with the accent. */
function StarGlyph(props: { filled: boolean; size: number }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: props.size, height: props.size }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.lineWidth = 2;
        cx.lineJoin = "round";
        cx.strokeStyle = props.filled ? colors.accent : colors.muted;
        if (props.filled) {
          cx.fillStyle = colors.accent;
          cx.fill(STAR);
        }
        cx.stroke(STAR);
      }}
    />
  );
}

const MARKS: { value: string; icon: LucideIconName; label: string }[] = [
  { value: "bold", icon: "bold", label: "Bold" },
  { value: "italic", icon: "italic", label: "Italic" },
  { value: "underline", icon: "underline", label: "Underline" },
  { value: "strike", icon: "strikethrough", label: "Strikethrough" },
];
const ALIGNS: { value: Align; label: string }[] = [
  { value: "left", label: "Align left" },
  { value: "center", label: "Align center" },
  { value: "right", label: "Align right" },
  { value: "justify", label: "Justify" },
];

const FILES = [
  { name: "Roadmap", kind: "Board", size: "24 cards", tone: () => chart.s1 },
  { name: "Q3 report", kind: "PDF", size: "2.4 MB", tone: () => chart.s2 },
  { name: "Launch", kind: "Deck", size: "18 slides", tone: () => chart.s3 },
  { name: "Brand kit", kind: "Folder", size: "36 files", tone: () => chart.s4 },
  { name: "Interviews", kind: "Notes", size: "9 pages", tone: () => chart.s5 },
  { name: "Budget", kind: "Sheet", size: "4 tabs", tone: () => chart.s1 },
];

/**
 * Toggle and ToggleGroup: a text toolbar (marks any number, the alignment
 * exactly one), a segmented view switcher, a favorite star that pops, the
 * sizes and looks, and a group the app disables.
 */
export function ToggleDemo() {
  const last = signal("—");

  /** The toolbar a toolbar row sits in: an inset track around its toggles. */
  const track = (): ViewStyle => ({
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 2,
    padding: 3,
    borderRadius: 10,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inset,
  });

  function Formatting() {
    const marks = signal<string[]>(["bold"]);
    const align = signal<Align>("left");
    const has = (m: string) => marks().includes(m);
    const decoration = () =>
      has("underline") && has("strike") ? "underline line-through" : has("underline") ? "underline" : has("strike") ? "line-through" : "none";
    return (
      <Card title="Text formatting" subtitle="Marks any number at once; the alignment exactly one">
        <ToggleGroup style={track()}>
          <Each of={MARKS}>
            {(m) => (
              <Tool
                icon={m().icon}
                label={m().label}
                pressed={has(m().value)}
                onChange={(on) => {
                  marks.set(on ? [...marks(), m().value] : marks().filter((v) => v !== m().value));
                  last.set(`${m().label}: ${on ? "on" : "off"}`);
                }}
              />
            )}
          </Each>
          <View style={{ width: 1, height: 18, marginHorizontal: 4, backgroundColor: colors.border }} />
          <Each of={ALIGNS}>
            {(a) => (
              <Tool
                glyph={(tint, size) => <AlignGlyph align={a().value} tint={tint} size={size} />}
                label={a().label}
                pressed={align() === a().value}
                onChange={(on) => {
                  // Exactly one: the pressed one stays pressed.
                  if (on) align.set(a().value);
                  last.set(on ? `Align: ${a().value}` : `Align: ${a().value} (stays)`);
                }}
              />
            )}
          </Each>
        </ToggleGroup>
        <View style={{ padding: 12, borderRadius: 8, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}>
          <Text
            style={{
              fontSize: pointer ? 14 : 16,
              lineHeight: pointer ? 21 : 24,
              color: colors.text,
              fontWeight: has("bold") ? "700" : "400",
              fontStyle: has("italic") ? "italic" : "normal",
              textDecorationLine: decoration(),
              textAlign: align(),
            }}
          >
            The quick brown fox jumps over the lazy dog, then naps in the sun until the evening breeze comes in.
          </Text>
        </View>
        <Caption label={pointer ? "Tab into the toolbar, then ← → move, Space presses" : "Press a mark, then an alignment"} note={`${marks().length} of ${MARKS.length} · ${align()}`} />
      </Card>
    );
  }

  function Views() {
    const view = signal<"grid" | "list">("grid");
    const seg = pointer ? 30 : 38;
    const inset = 2;
    const x = createAnimatedValue(0);
    effect(() => {
      const to = view() === "grid" ? 0 : seg;
      if (reduceMotion()) x.set(to);
      else x.spring(to, motion.settle);
    });
    const choose = (next: "grid" | "list", on: boolean) => {
      if (!on || next === view()) return;
      if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
      view.set(next);
      last.set(`View: ${next}`);
    };
    const segment = (value: "grid" | "list", label: string, glyph: (tint: string) => JSX.Element) => (
      <Toggle
        pressed={view() === value}
        accessibilityLabel={label}
        onChange={({ pressed }) => choose(value, pressed)}
        style={{ width: seg, height: seg - 2 * inset, alignItems: "center", justifyContent: "center", borderRadius: 7, ...transition() }}
        hoverStyle={view() === value ? undefined : hovered()}
        activeStyle={{ transform: [{ scale: 0.9 }] }}
        focusStyle={focusRing(1)}
      >
        {glyph(view() === value ? colors.text : colors.muted)}
      </Toggle>
    );
    const grid = () => view() === "grid";
    return (
      <Card title="View switcher" subtitle="A segmented group: the thumb springs to the one shown" right={<Badge label={`${FILES.length} items`} />}>
        <ToggleGroup
          style={{
            flexDirection: "row",
            alignSelf: "flex-start",
            padding: inset,
            borderRadius: 9,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: finish.track.borderColor,
            backgroundColor: colors.track,
            boxShadow: finish.track.boxShadow,
          }}
        >
          <View
            style={{
              pointerEvents: "none",
              position: "absolute",
              top: inset,
              bottom: inset,
              left: inset,
              width: seg,
              borderRadius: 7,
              borderCurve: "continuous",
              borderWidth: 1,
              ...finish.raised,
              transform: [{ translateX: x }],
            }}
          />
          {segment("grid", "Grid view", (tint) => <GridGlyph tint={tint} size={pointer ? 15 : 17} />)}
          {segment("list", "List view", (tint) => <LucideIcon name="list" size={pointer ? 15 : 17} tint={tint} />)}
        </ToggleGroup>
        <View style={{ flexDirection: grid() ? "row" : "column", flexWrap: grid() ? "wrap" : "nowrap", gap: grid() ? 8 : 0 }}>
          <Each of={FILES}>
            {(f, i) => (
              <View
                style={
                  grid()
                    ? { flexGrow: 1, flexBasis: "28%", height: pointer ? 76 : 88, padding: 10, gap: 4, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.inset, justifyContent: "flex-end" }
                    : { flexDirection: "row", alignItems: "center", gap: 10, height: pointer ? 36 : 48, borderTopWidth: i() === 0 ? 0 : 1, borderTopColor: colors.line }
                }
              >
                <View
                  style={{
                    width: grid() ? 22 : 20,
                    height: grid() ? 22 : 20,
                    borderRadius: 6,
                    backgroundColor: alpha(f().tone(), 0.22),
                    borderWidth: 1,
                    borderColor: alpha(f().tone(), 0.5),
                    ...(grid() ? { position: "absolute", top: 10, left: 10 } : {}),
                  }}
                />
                <Text style={{ flex: grid() ? undefined : 1, fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{f().name}</Text>
                <Text style={{ fontSize: pointer ? 11 : 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{grid() ? f().kind : `${f().kind} · ${f().size}`}</Text>
              </View>
            )}
          </Each>
        </View>
      </Card>
    );
  }

  /** A favorite star: it pops and throws a ring when turned on, and dips back when turned off. */
  function Star(props: { label: string; on: boolean; count: number; onChange: (on: boolean) => void }) {
    const side = pointer ? 18 : 22;
    const pop = createAnimatedValue(1);
    const ring = createAnimatedValue(1);
    return (
      <Toggle
        pressed={props.on}
        accessibilityLabel={props.label}
        onChange={({ pressed }) => {
          props.onChange(pressed);
          if (reduceMotion()) return;
          if (pressed) {
            pop.set(0.5);
            pop.spring(1, { stiffness: 420, damping: 9 });
            ring.set(0);
            ring.timing(1, { duration: 460, easing: Easing.out(Easing.cubic) });
          } else {
            pop.set(0.8);
            pop.spring(1, motion.press);
          }
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, height: pointer ? 28 : 36, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: "transparent", ...transition() }}
        pressedStyle={{ backgroundColor: alpha(colors.accent, 0.12), borderColor: alpha(colors.accent, 0.3) }}
        hoverStyle={props.on ? undefined : hovered()}
        focusStyle={focusRing(1)}
      >
        <View style={{ width: side, height: side, alignItems: "center", justifyContent: "center" }}>
          <View
            style={{
              pointerEvents: "none",
              position: "absolute",
              width: side,
              height: side,
              borderRadius: side / 2,
              borderWidth: 2,
              borderColor: colors.accent,
              opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }),
              transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.9] }) }],
            }}
          />
          <View style={{ transform: [{ scale: pop }] }}>
            <StarGlyph filled={props.on} size={side} />
          </View>
        </View>
        <Text style={{ fontSize: pointer ? 12 : 14, fontWeight: "500", color: props.on ? colors.text : colors.muted, fontVariant: ["tabular-nums"] }}>{props.count}</Text>
      </Toggle>
    );
  }

  function Favorites() {
    const items = [
      { name: "Q3 report", detail: "Finance · edited 2h ago", stars: 41 },
      { name: "Launch checklist", detail: "Product · edited yesterday", stars: 128 },
      { name: "Design review", detail: "Design · edited Monday", stars: 7 },
    ];
    const starred = signal<string[]>(["Launch checklist"]);
    return (
      <Card title="Favorite" subtitle="One toggle alone: the star pops when it turns on" right={<Badge label={`${starred().length} starred`} />}>
        <View>
          <Each of={items}>
            {(item, i) => {
              const on = () => starred().includes(item().name);
              return (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: pointer ? 44 : 56, borderTopWidth: i() === 0 ? 0 : 1, borderTopColor: colors.line }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: pointer ? 13 : 15, color: colors.text }}>{item().name}</Text>
                    <Text style={{ fontSize: pointer ? 12 : 13, color: colors.muted }}>{item().detail}</Text>
                  </View>
                  <Star
                    label={`Star ${item().name}`}
                    on={on()}
                    count={item().stars + (on() ? 1 : 0)}
                    onChange={(next) => {
                      starred.set(next ? [...starred(), item().name] : starred().filter((n) => n !== item().name));
                      last.set(`${item().name}: ${next ? "starred" : "unstarred"}`);
                    }}
                  />
                </View>
              );
            }}
          </Each>
        </View>
      </Card>
    );
  }

  function Sizes() {
    const on = signal<string[]>(["regular", "outline-regular"]);
    const flip = (key: string, label: string, next: boolean) => {
      on.set(next ? [...on(), key] : on().filter((k) => k !== key));
      last.set(`${label}: ${next ? "on" : "off"}`);
    };
    const sizes: Size[] = ["small", "regular", "large"];
    const caption = (s: Size) => s[0].toUpperCase() + s.slice(1);
    return (
      <Card title="Sizes and looks" subtitle="Bare until pressed, or on a field's edge">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ width: 60, fontSize: pointer ? 12 : 13, color: colors.faint }}>Ghost</Text>
          <Each of={sizes}>
            {(s) => <Tool icon="star" size={s()} label={`${caption(s())} star`} pressed={on().includes(s())} onChange={(next) => flip(s(), `${caption(s())} star`, next)} />}
          </Each>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={{ width: 60, fontSize: pointer ? 12 : 13, color: colors.faint }}>Outline</Text>
          <Each of={sizes}>
            {(s) => (
              <Tool
                variant="outline"
                size={s()}
                icon="bell"
                text={caption(s())}
                label={`${caption(s())} alerts`}
                pressed={on().includes(`outline-${s()}`)}
                onChange={(next) => flip(`outline-${s()}`, `${caption(s())} alerts`, next)}
              />
            )}
          </Each>
        </View>
      </Card>
    );
  }

  function Disabled() {
    const locked = signal(false);
    const on = signal<string[]>(["comments"]);
    const tools: { value: string; icon: LucideIconName; label: string }[] = [
      { value: "notify", icon: "bell", label: "Notify" },
      { value: "share", icon: "link", label: "Share link" },
      { value: "comments", icon: "message-circle", label: "Comments" },
    ];
    return (
      <Card title="Disabled" subtitle="A group the app locks, and one toggle on its own" right={<Switch value={locked()} onChange={(v) => locked.set(v)} label="Lock toolbar" />}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <ToggleGroup disabled={locked()} style={track()}>
            <Each of={tools}>
              {(t) => (
                <Tool
                  icon={t().icon}
                  label={t().label}
                  pressed={on().includes(t().value)}
                  onChange={(next) => {
                    on.set(next ? [...on(), t().value] : on().filter((v) => v !== t().value));
                    last.set(`${t().label}: ${next ? "on" : "off"}`);
                  }}
                />
              )}
            </Each>
          </ToggleGroup>
          <Tool icon="pencil" text="Edit" label="Edit (view only)" variant="outline" pressed={false} disabled onChange={() => {}} />
        </View>
        <Caption label={locked() ? "Locked: no presses, no focus, dimmed for screen readers" : "Lock the toolbar: every toggle in it is disabled"} />
      </Card>
    );
  }

  function Last() {
    return (
      <Card title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Formatting, Views, Favorites, Sizes, Disabled, Last]} />;
}
