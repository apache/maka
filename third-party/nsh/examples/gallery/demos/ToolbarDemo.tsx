import { Canvas, cleanup, createAnimatedValue, Easing, effect, type JSX, LayoutAnimation, Path2D, platform, reduceMotion, signal, Text, token, View, type ViewStyle } from "nsh";
import { Button as BaseButton, Link, Menu, MenuItem, MenuSeparator, Popover, Slider, Toggle, ToggleGroup, Toolbar, ToolbarGroup, ToolbarSeparator } from "nsh/base";
import { alpha, Badge, Caption, Card, chart, colors, DemoPage, finish, focusRing, hovered, menuIndicator, MenuMark, mono, motion, PopIn, popupSurface, sliderFill, sliderLook, Tip, Toggle as Switch } from "../ui";
import { Field } from "./OverlayUi";
import { LucideIcon, type LucideIconName } from "./RichEditorUi";

// `nsh/base`'s `Toolbar` owns the keyboard and the semantics of a bar of
// controls: one Tab stop whose arrow keys (along its `axis`) move between
// the `Button`s, `Toggle`s and `Link`s inside it, its `ToolbarGroup`s and
// `ToggleGroup`s included; screen readers hear a toolbar, its groups by
// name. What each control does and how it all looks are the gallery's:
// ghost tools that raise when pressed, a press that sinks, a thumb that
// springs to the tool chosen; none of the motion with reduced motion.

const pointer = platform.idiom === "desktop";

/** A tool's side and its icon's: compact with a pointer, roomier on a touch screen. */
const TOOL = pointer ? { side: 28, icon: 16, text: 13 } : { side: 38, icon: 18, text: 15 };

/** The fades and the sink every tool shares; nothing moves with reduced motion. */
const transition = (): ViewStyle => ({
  transitionProperty: "background-color, border-color, box-shadow, transform, opacity",
  transitionDuration: reduceMotion() ? 0 : 140,
  transitionTimingFunction: "ease-out",
});

/** A tool's surface: bare while off, the raised pill while pressed or open, a hover fill, the focus ring. */
/** The state styles of a tool, spread on its `Button` or `Toggle`. */
type Look = { style: ViewStyle; hoverStyle?: ViewStyle; activeStyle: ViewStyle; focusStyle: ViewStyle; disabledStyle: ViewStyle };

const toolLook = (on: boolean, wide = false): Look => ({
  style: {
    minWidth: TOOL.side,
    height: TOOL.side,
    paddingHorizontal: wide ? 8 : 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: TOOL.side / 4 + 1,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: "transparent",
    ...(on ? finish.pill : {}),
    ...transition(),
  },
  hoverStyle: on ? undefined : hovered(),
  activeStyle: { transform: [{ scale: 0.92 }] },
  focusStyle: focusRing(1),
  disabledStyle: { opacity: 0.35 },
});

/** The inset track a horizontal toolbar sits in. */
const track = (): ViewStyle => ({
  alignItems: "center",
  alignSelf: "stretch",
  gap: 2,
  padding: 3,
  borderRadius: 10,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.inset,
});

/** A hairline between runs of a toolbar's items. */
function Rule(props: { vertical?: boolean }) {
  return (
    <ToolbarSeparator
      style={props.vertical ? { height: 1, alignSelf: "stretch", marginVertical: 4, marginHorizontal: 6, backgroundColor: colors.line } : { width: 1, height: 18, marginHorizontal: 4, backgroundColor: colors.line }}
    />
  );
}

// Glyphs the gallery's Lucide subset lacks, drawn on Lucide's 24-point grid and pen.
const GLYPHS = {
  "skip-back": ["M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z", "M3 20V4"],
  "skip-forward": ["M21 4v16", "M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"],
  shuffle: ["m18 14 4 4-4 4", "m18 2 4 4-4 4", "M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22", "M2 6h1.972a4 4 0 0 1 3.6 2.2", "M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"],
  repeat: ["m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"],
  "repeat-1": ["m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3", "M11 10h1v4"],
  "volume-2": ["M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z", "M16 9a5 5 0 0 1 0 6", "M19.364 18.364a9 9 0 0 0 0-12.728"],
  "volume-x": ["M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z", "m22 9-6 6", "m16 9 6 6"],
  pointer: ["M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"],
  square: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"],
  eraser: ["m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21", "M22 21H7", "m5 11 9 9"],
  "zoom-in": ["M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z", "m21 21-4.3-4.3", "M11 8v6", "M8 11h6"],
  "zoom-out": ["M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z", "m21 21-4.3-4.3", "M8 11h6"],
} as const;
type GlyphName = keyof typeof GLYPHS;
const PATHS = Object.fromEntries(Object.entries(GLYPHS).map(([name, ds]) => [name, ds.map((d) => new Path2D(d))])) as Record<GlyphName, Path2D[]>;

/** A drawn glyph. */
function Glyph(props: { name: GlyphName; size?: number; tint: string }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: props.size ?? TOOL.icon, height: props.size ?? TOOL.icon }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        for (const p of PATHS[props.name]) cx.stroke(p);
      }}
    />
  );
}

type Icon = { icon?: LucideIconName; glyph?: GlyphName };

function ToolIcon(props: Icon & { tint: string; size?: number }) {
  return (
    <>
      <If when={props.icon}>
        <LucideIcon name={props.icon!} size={props.size ?? TOOL.icon} tint={props.tint} />
      </If>
      <If when={props.glyph}>
        <Glyph name={props.glyph!} size={props.size} tint={props.tint} />
      </If>
    </>
  );
}

/** A command of a toolbar: a `Button`, its label what screen readers say and, with a pointer, its tooltip. */
function Command(props: Icon & { label: string; text?: string; shortcut?: string; disabled?: boolean; on?: boolean; onPress: () => void }) {
  return (
    <BaseButton accessibilityLabel={props.label} disabled={props.disabled} tooltip={<Tip label={props.label} shortcut={props.shortcut} />} onPress={props.onPress} {...toolLook(!!props.on, !!props.text)}>
      <ToolIcon icon={props.icon} glyph={props.glyph} tint={props.on ? colors.text : colors.muted} />
      <If when={props.text}>
        <Text style={{ fontSize: TOOL.text, fontWeight: "500", color: colors.text }}>{props.text}</Text>
      </If>
    </BaseButton>
  );
}

/**
 * A popup's trigger in a toolbar: a view the `Menu` or `Popover` gives its presses, focus and `expanded` state, and
 * so one of the toolbar's items (the arrows reach it, Space and Return open it).
 */
function Trigger(props: { label: string; open: boolean; wide?: boolean; tip: JSX.Element; children: JSX.Element }) {
  return (
    <View role="button" accessibilityLabel={props.label} tooltip={props.tip} {...toolLook(props.open, props.wide)}>
      {props.children}
    </View>
  );
}

/** An on / off tool of a toolbar: a `Toggle`, raised while pressed. */
function Mark(props: Icon & { label: string; shortcut?: string; pressed: boolean; disabled?: boolean; onChange: (pressed: boolean) => void }) {
  return (
    <Toggle
      pressed={props.pressed}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      tooltip={<Tip label={props.label} shortcut={props.shortcut} />}
      onChange={({ pressed }) => props.onChange(pressed)}
      {...toolLook(false)}
      pressedStyle={finish.pill}
      hoverStyle={props.pressed ? undefined : hovered()}
    >
      <ToolIcon icon={props.icon} glyph={props.glyph} tint={props.pressed ? colors.text : colors.muted} />
    </Toggle>
  );
}

type Align = "left" | "center" | "right" | "justify";
type Block = "Paragraph" | "Heading" | "Quote";

/** Four lines of a paragraph, set as `align` sets them. */
function AlignGlyph(props: { align: Align; tint: string }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: TOOL.icon, height: TOOL.icon }}
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

const MARKS: { value: string; icon: LucideIconName; label: string; shortcut: string }[] = [
  { value: "bold", icon: "bold", label: "Bold", shortcut: "⌘B" },
  { value: "italic", icon: "italic", label: "Italic", shortcut: "⌘I" },
  { value: "underline", icon: "underline", label: "Underline", shortcut: "⌘U" },
  { value: "strike", icon: "strikethrough", label: "Strikethrough", shortcut: "⌘⇧X" },
];
const ALIGNS: { value: Align; label: string }[] = [
  { value: "left", label: "Align left" },
  { value: "center", label: "Align center" },
  { value: "right", label: "Align right" },
  { value: "justify", label: "Justify" },
];
const BLOCKS: { value: Block; icon: LucideIconName }[] = [
  { value: "Paragraph", icon: "pilcrow" },
  { value: "Heading", icon: "heading-2" },
  { value: "Quote", icon: "text-quote" },
];

/** A row of a toolbar's menu; `checked` makes it one choice of a group (the block, the alignment), its dot the app's mark. */
function Item(props: { label: string; icon?: LucideIconName; onSelect: () => void; checked?: boolean; disabled?: boolean }) {
  const row = pointer ? { height: 26, radius: 6, font: 13, icon: 14 } : { height: 46, radius: 10, font: 16, icon: 18 };
  return (
    <MenuItem
      onSelect={props.onSelect}
      disabled={props.disabled}
      checked={props.checked}
      role={props.checked === undefined ? undefined : "menuitemradio"}
      indicatorClass={menuIndicator}
      indicator={props.checked === undefined ? undefined : <MenuMark kind="dot" size={row.icon} tint={colors.accent} />}
      hoverStyle={{ backgroundColor: token("accent") }}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.1) }}
      disabledStyle={{ opacity: 0.35 }}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, height: row.height, paddingHorizontal: 8, borderRadius: row.radius }}
    >
      <If when={props.icon}>
        <LucideIcon name={props.icon!} size={row.icon} tint={colors.muted} />
      </If>
      <Text style={{ flex: 1, fontSize: row.font, color: colors.text }}>{props.label}</Text>
    </MenuItem>
  );
}

/** A menu's items: the popup surface coming in on desktops, the sheet's rows on touch screens. */
function MenuPanel(props: { children: JSX.Element }) {
  if (!pointer) return props.children;
  return <PopIn style={{ ...popupSurface(), minWidth: 190, padding: 4 }}>{props.children}</PopIn>;
}

const sheet = pointer ? undefined : { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 34 };
const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/**
 * Toolbar, ToolbarGroup and ToolbarSeparator: a text editor's formatting
 * bar (history, a block menu, marks, an alignment that folds into the
 * overflow menu on a narrow pane, a link popover), a media player's
 * transport, a vertical palette of tools, and a toolbar the app locks.
 */
export function ToolbarDemo() {
  const last = signal("—");

  function Formatting() {
    type State = { marks: string[]; align: Align; block: Block; link: string };
    const state = signal<State>({ marks: ["bold"], align: "left", block: "Paragraph", link: "" });
    const past = signal<State[]>([]);
    const future = signal<State[]>([]);
    const commit = (next: Partial<State>, what: string) => {
      past.set([...past(), state()].slice(-50));
      future.set([]);
      state.set({ ...state(), ...next });
      last.set(what);
    };
    const undo = () => {
      const prev = past().at(-1);
      if (!prev) return;
      future.set([state(), ...future()]);
      past.set(past().slice(0, -1));
      state.set(prev);
      last.set("Undo");
    };
    const redo = () => {
      const next = future()[0];
      if (!next) return;
      past.set([...past(), state()]);
      future.set(future().slice(1));
      state.set(next);
      last.set("Redo");
    };
    const has = (m: string) => state().marks.includes(m);
    const toggleMark = (m: { value: string; label: string }, on: boolean) =>
      commit({ marks: on ? [...state().marks, m.value] : state().marks.filter((v) => v !== m.value) }, `${m.label}: ${on ? "on" : "off"}`);
    // A narrow pane folds the alignment into the overflow menu.
    const width = signal(0);
    const compact = () => width() > 0 && width() < (pointer ? 470 : 520);
    effect(() => {
      compact();
      if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    });
    const blockOpen = signal(false);
    const moreOpen = signal(false);
    const linkOpen = signal(false);
    const draft = signal("");
    const applyLink = () => {
      commit({ link: draft().trim() }, draft().trim() ? `Link: ${draft().trim()}` : "Link removed");
      linkOpen.set(false);
    };
    const decoration = () => (has("underline") && has("strike") ? "underline line-through" : has("underline") ? "underline" : has("strike") ? "line-through" : "none");
    const block = () => state().block;
    return (
      <Card title="Text formatting" subtitle="History, a block menu, marks, alignment and a link: one stop of Tab" right={<Badge label={`${past().length} edits`} />}>
        <Toolbar accessibilityLabel="Formatting" style={track()} onLayout={({ bounds }) => width.set(bounds.size.width)}>
          <ToolbarGroup accessibilityLabel="History" style={{ gap: 2 }}>
            <Command icon="undo-2" label="Undo" shortcut="⌘Z" disabled={past().length === 0} onPress={undo} />
            <Command icon="redo-2" label="Redo" shortcut="⌘⇧Z" disabled={future().length === 0} onPress={redo} />
          </ToolbarGroup>
          <Rule />
          <Menu
            offset={6}
            margin={8}
            popupStyle={sheet}
            backdropStyle={backdrop}
            onOpenChange={({ open }) => blockOpen.set(open)}
            trigger={
              <Trigger label={`Block: ${block()}`} tip={<Tip label="Turn into" />} open={blockOpen()} wide>
                <LucideIcon name={BLOCKS.find((b) => b.value === block())!.icon} size={TOOL.icon} tint={colors.text} />
                <If when={!compact()}>
                  <Text style={{ fontSize: TOOL.text, color: colors.text }}>{block()}</Text>
                </If>
                <View style={{ transform: [{ rotate: blockOpen() ? "180deg" : "0deg" }], ...transition() }}>
                  <Text style={{ fontSize: 9, color: colors.faint }}>▾</Text>
                </View>
              </Trigger>
            }
          >
            <MenuPanel>
              <Each of={BLOCKS}>
                {(b) => <Item label={b().value} icon={b().icon} checked={block() === b().value} onSelect={() => commit({ block: b().value }, `Block: ${b().value}`)} />}
              </Each>
            </MenuPanel>
          </Menu>
          <Rule />
          {/* A toggle group inside the toolbar is one of its groups: its toggles are the toolbar's items. */}
          <ToggleGroup style={{ flexDirection: "row", gap: 2 }}>
            <Each of={MARKS}>{(m) => <Mark icon={m().icon} label={m().label} shortcut={m().shortcut} pressed={has(m().value)} onChange={(on) => toggleMark(m(), on)} />}</Each>
          </ToggleGroup>
          <If when={!compact()}>
            <Rule />
            <ToolbarGroup accessibilityLabel="Alignment" style={{ gap: 2 }}>
              <Each of={ALIGNS}>
                {(a) => (
                  <Toggle
                    pressed={state().align === a().value}
                    accessibilityLabel={a().label}
                    tooltip={<Tip label={a().label} />}
                    onChange={({ pressed }) => pressed && commit({ align: a().value }, `Align: ${a().value}`)}
                    {...toolLook(false)}
                    pressedStyle={finish.pill}
                    hoverStyle={state().align === a().value ? undefined : hovered()}
                  >
                    <AlignGlyph align={a().value} tint={state().align === a().value ? colors.text : colors.muted} />
                  </Toggle>
                )}
              </Each>
            </ToolbarGroup>
          </If>
          <Rule />
          <Popover
            open={linkOpen()}
            onOpenChange={({ open }) => {
              if (open) draft.set(state().link);
              linkOpen.set(open);
            }}
            placement="bottom"
            align="start"
            offset={6}
            margin={8}
            trigger={
              <Trigger label="Link" tip={<Tip label="Link" shortcut="⌘K" />} open={linkOpen() || !!state().link}>
                <LucideIcon name="link" size={TOOL.icon} tint={state().link ? colors.accent : colors.muted} />
              </Trigger>
            }
          >
            {/* The popover's field and buttons are stops of their own, not the toolbar's items. */}
            <PopIn style={{ ...popupSurface(), width: pointer ? 280 : 320, padding: 12, gap: 10 }}>
              <Text style={{ fontSize: pointer ? 12 : 14, fontWeight: "600", color: colors.text }}>Link to</Text>
              <Field value={draft()} onChange={({ value }) => draft.set(value)} onSubmit={applyLink} placeholder="https://" keyboardType="url" autoCapitalize="none" accessibilityLabel="Link address" autoFocus />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
                <Command label="Remove link" text="Remove" disabled={!state().link} onPress={() => {
                  draft.set("");
                  applyLink();
                }} />
                <Command label="Apply link" text="Apply" on onPress={applyLink} />
              </View>
            </PopIn>
          </Popover>
          <View style={{ flex: 1 }} />
          <Menu
            align="end"
            offset={6}
            margin={8}
            popupStyle={sheet}
            backdropStyle={backdrop}
            onOpenChange={({ open }) => moreOpen.set(open)}
            trigger={
              <Trigger label="More formatting" tip={<Tip label="More" />} open={moreOpen()}>
                <LucideIcon name="ellipsis" size={TOOL.icon} tint={colors.muted} />
              </Trigger>
            }
          >
            <MenuPanel>
              <If when={compact()}>
                <Each of={ALIGNS}>
                  {(a) => <Item label={a().label} checked={state().align === a().value} onSelect={() => commit({ align: a().value }, `Align: ${a().value}`)} />}
                </Each>
                <MenuSeparator style={{ height: 1, marginVertical: 4, marginHorizontal: 4, backgroundColor: colors.line }} />
              </If>
              <Item label="Clear formatting" icon="x" disabled={state().marks.length === 0 && state().block === "Paragraph"} onSelect={() => commit({ marks: [], block: "Paragraph" }, "Clear formatting")} />
              <Item label="Copy as Markdown" icon="copy" onSelect={() => last.set("Copied as Markdown")} />
            </MenuPanel>
          </Menu>
        </Toolbar>
        <View style={{ padding: 12, borderRadius: 8, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line, borderLeftWidth: block() === "Quote" ? 3 : 1, borderLeftColor: block() === "Quote" ? colors.accent : colors.line }}>
          <Text
            style={{
              fontSize: block() === "Heading" ? (pointer ? 20 : 22) : pointer ? 14 : 16,
              lineHeight: block() === "Heading" ? (pointer ? 26 : 30) : pointer ? 21 : 24,
              color: block() === "Quote" ? colors.muted : colors.text,
              fontWeight: has("bold") || block() === "Heading" ? "700" : "400",
              fontStyle: has("italic") || block() === "Quote" ? "italic" : "normal",
              textDecorationLine: decoration(),
              textAlign: state().align,
            }}
          >
            The quick brown fox jumps over{" "}
            <Text style={{ color: state().link ? colors.accent : undefined, textDecorationLine: state().link ? "underline" : decoration() }}>the lazy dog</Text>, then naps in the sun until the
            evening breeze comes in.
          </Text>
        </View>
        <Caption
          label={pointer ? "Tab into the bar: ← → move, Home / End jump, Space presses" : "Press a tool; narrow panes fold the alignment into ⋯"}
          note={`${state().marks.length} marks · ${state().align}${compact() ? " · folded" : ""}`}
        />
      </Card>
    );
  }

  function Player() {
    const TRACKS = [
      { title: "Night Drive", artist: "Halcyon Arcade", length: 214, tone: () => chart.s1 },
      { title: "Paper Lanterns", artist: "Mira Sol", length: 187, tone: () => chart.s3 },
      { title: "Low Tide", artist: "The Quiet Fields", length: 243, tone: () => chart.s2 },
    ];
    const index = signal(0);
    const playing = signal(false);
    const shuffle = signal(false);
    const repeat = signal<"off" | "all" | "one">("off");
    const muted = signal(false);
    const volume = signal(70);
    const elapsed = signal(0);
    // The bar moves natively from where it is to the end over what is left;
    // JS only ticks the clock once a second.
    const progress = createAnimatedValue(0);
    const track = () => TRACKS[index()];
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      progress.stop();
    };
    cleanup(stop);
    const run = () => {
      stop();
      const left = track().length - elapsed();
      progress.set(elapsed() / track().length);
      progress.timing(1, { duration: left * 1000, easing: Easing.linear });
      timer = setInterval(() => {
        if (elapsed() + 1 >= track().length) return next(true);
        elapsed.set(elapsed() + 1);
      }, 1000);
    };
    const load = (i: number) => {
      index.set((i + TRACKS.length) % TRACKS.length);
      elapsed.set(0);
      progress.set(0);
      if (playing()) run();
    };
    function next(ended = false) {
      if (ended && repeat() === "one") return load(index());
      if (ended && repeat() === "off" && index() === TRACKS.length - 1) {
        playing.set(false);
        stop();
        return;
      }
      load(shuffle() ? index() + 1 + Math.floor(Math.random() * (TRACKS.length - 1)) : index() + 1);
      last.set(`Next: ${track().title}`);
    }
    const previous = () => {
      // Past the first seconds, back to the start of the track.
      load(elapsed() > 3 ? index() : index() - 1);
      last.set(`Previous: ${track().title}`);
    };
    const play = () => {
      playing.set(!playing());
      if (playing()) run();
      else stop();
      last.set(playing() ? `Play: ${track().title}` : "Pause");
    };
    // The play button's icon pops as it swaps.
    const pop = createAnimatedValue(1);
    effect(() => {
      playing();
      if (reduceMotion()) return;
      pop.set(0.7);
      pop.spring(1, motion.press);
    });
    const time = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const cycle = () => {
      repeat.set(repeat() === "off" ? "all" : repeat() === "all" ? "one" : "off");
      last.set(`Repeat: ${repeat()}`);
    };
    const big = pointer ? 40 : 52;
    return (
      <Card title="Media player" subtitle="Transport and volume: buttons, toggles and a slider in one bar">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ width: pointer ? 56 : 64, height: pointer ? 56 : 64, borderRadius: 10, borderCurve: "continuous", backgroundColor: alpha(track().tone(), 0.3), borderWidth: 1, borderColor: alpha(track().tone(), 0.5) }} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: pointer ? 14 : 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{track().title}</Text>
            <Text style={{ fontSize: pointer ? 12 : 14, color: colors.muted, numberOfLines: 1 }}>{track().artist}</Text>
          </View>
          <Badge label={`${index() + 1} / ${TRACKS.length}`} />
        </View>
        <View style={{ gap: 4 }}>
          <View style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: colors.track }}>
            <View style={{ height: 4, width: "100%", borderRadius: 2, backgroundColor: colors.accent, transformOrigin: "left", transform: [{ scaleX: progress }] }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 11, color: colors.faint, fontFamily: mono }}>{time(elapsed())}</Text>
            <Text style={{ fontSize: 11, color: colors.faint, fontFamily: mono }}>-{time(track().length - elapsed())}</Text>
          </View>
        </View>
        <Toolbar accessibilityLabel="Playback" style={{ alignItems: "center", gap: pointer ? 4 : 8, flexWrap: "wrap" }}>
          <Mark glyph="shuffle" label="Shuffle" pressed={shuffle()} onChange={(on) => {
            shuffle.set(on);
            last.set(`Shuffle: ${on ? "on" : "off"}`);
          }} />
          <ToolbarGroup accessibilityLabel="Transport" style={{ alignItems: "center", gap: pointer ? 4 : 8 }}>
            <Command glyph="skip-back" label="Previous" onPress={previous} />
            <BaseButton
              accessibilityLabel={playing() ? "Pause" : "Play"}
              tooltip={<Tip label={playing() ? "Pause" : "Play"} shortcut="Space" />}
              onPress={play}
              style={{ width: big, height: big, borderRadius: big / 2, alignItems: "center", justifyContent: "center", backgroundColor: colors.light, ...transition() }}
              hoverStyle={{ opacity: 0.9 }}
              activeStyle={{ transform: [{ scale: 0.9 }] }}
              focusStyle={focusRing(2)}
            >
              <View style={{ transform: [{ scale: pop }] }}>
                <If when={playing()} else={<LucideIcon name="play" size={pointer ? 18 : 22} tint={colors.onLight} />}>
                  <LucideIcon name="pause" size={pointer ? 18 : 22} tint={colors.onLight} />
                </If>
              </View>
            </BaseButton>
            <Command glyph="skip-forward" label="Next" onPress={() => next()} />
          </ToolbarGroup>
          <Command glyph={repeat() === "one" ? "repeat-1" : "repeat"} label={`Repeat: ${repeat()}`} on={repeat() !== "off"} onPress={cycle} />
          <View style={{ flex: 1 }} />
          <ToolbarGroup accessibilityLabel="Volume" style={{ alignItems: "center", gap: 6 }}>
            <Mark glyph={muted() || volume() === 0 ? "volume-x" : "volume-2"} label="Mute" pressed={muted()} onChange={(on) => {
              muted.set(on);
              last.set(on ? "Muted" : "Unmuted");
            }} />
            {/* A slider keeps its own arrow keys: it is a stop of its own, after the toolbar's. */}
            <Slider
              value={volume()}
              step={5}
              accessibilityLabel="Volume"
              disabled={muted()}
              onChange={({ value }) => volume.set(value as number)}
              onChangeEnd={({ value }) => last.set(`Volume: ${value}`)}
              rangeStyle={sliderFill(0, volume() / 100)}
              {...sliderLook()}
              style={{ width: pointer ? 96 : 120 }}
            />
          </ToolbarGroup>
        </Toolbar>
      </Card>
    );
  }

  function Palette() {
    const TOOLS: { value: string; label: string; key: string; icon?: LucideIconName; glyph?: GlyphName; hint: string }[] = [
      { value: "select", label: "Select", key: "V", glyph: "pointer", hint: "Click a shape to select it; drag to move it" },
      { value: "hand", label: "Hand", key: "H", icon: "hand", hint: "Drag the canvas to pan around it" },
      { value: "pen", label: "Pen", key: "P", icon: "pencil", hint: "Draw freehand strokes" },
      { value: "shape", label: "Rectangle", key: "R", glyph: "square", hint: "Drag out a rectangle" },
      { value: "text", label: "Text", key: "T", icon: "type", hint: "Click to place a text box" },
      { value: "eraser", label: "Eraser", key: "E", glyph: "eraser", hint: "Locked: the document is read-only for erasing" },
    ];
    const tool = signal("select");
    const zoom = signal(100);
    const at = () => TOOLS.findIndex((t) => t.value === tool());
    // The selection springs to the tool chosen.
    const step = TOOL.side + 2;
    const y = createAnimatedValue(0);
    effect(() => {
      const to = at() * step;
      if (reduceMotion()) y.set(to);
      else y.spring(to, motion.settle);
    });
    const current = () => TOOLS[at()];
    return (
      <Card title="Tool palette" subtitle="A vertical toolbar: ↑ ↓ move, ← → are left alone">
        <View style={{ flexDirection: "row", gap: 12, alignItems: "stretch" }}>
          <Toolbar axis="vertical" accessibilityLabel="Tools" style={{ ...track(), alignSelf: "flex-start", gap: 2 }}>
            <View style={{ pointerEvents: "none", position: "absolute", top: 3, left: 3, width: TOOL.side, height: TOOL.side, borderRadius: TOOL.side / 4 + 1, borderWidth: 1, ...finish.raised, transform: [{ translateY: y }] }} />
            <Each of={TOOLS}>
              {(t) => (
                <Toggle
                  pressed={tool() === t().value}
                  disabled={t().value === "eraser"}
                  accessibilityLabel={t().label}
                  tooltip={<Tip label={t().label} shortcut={t().key} placement="right" />}
                  onChange={({ pressed }) => {
                    if (!pressed) return;
                    tool.set(t().value);
                    last.set(`Tool: ${t().label}`);
                  }}
                  {...toolLook(false)}
                  hoverStyle={tool() === t().value ? undefined : hovered()}
                >
                  <ToolIcon icon={t().icon} glyph={t().glyph} tint={tool() === t().value ? colors.text : colors.muted} />
                </Toggle>
              )}
            </Each>
            <Rule vertical />
            <Command glyph="zoom-in" label="Zoom in" disabled={zoom() >= 200} onPress={() => {
              zoom.set(zoom() + 25);
              last.set(`Zoom: ${zoom()}%`);
            }} />
            <Command glyph="zoom-out" label="Zoom out" disabled={zoom() <= 50} onPress={() => {
              zoom.set(zoom() - 25);
              last.set(`Zoom: ${zoom()}%`);
            }} />
          </Toolbar>
          <View style={{ flex: 1, minHeight: 200, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.inset, overflow: "hidden", alignItems: "center", justifyContent: "center", gap: 10, padding: 12 }}>
            <View style={{ transform: [{ scale: zoom() / 100 }], ...transition(), flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
              <View style={{ width: 44, height: 30, borderRadius: 6, backgroundColor: alpha(chart.s1, 0.3), borderWidth: 1, borderColor: alpha(chart.s1, 0.6) }} />
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: alpha(chart.s3, 0.3), borderWidth: 1, borderColor: alpha(chart.s3, 0.6) }} />
              <View style={{ width: 36, height: 46, borderRadius: 6, backgroundColor: alpha(chart.s2, 0.3), borderWidth: 1, borderColor: alpha(chart.s2, 0.6) }} />
            </View>
            <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "600", color: colors.text }}>{current().label}</Text>
            <Text style={{ fontSize: pointer ? 12 : 13, color: colors.muted, textAlign: "center" }}>{current().hint}</Text>
            <Text style={{ fontSize: 11, color: colors.faint, fontFamily: mono }}>{`${zoom()}%`}</Text>
          </View>
        </View>
      </Card>
    );
  }

  function Disabled() {
    const locked = signal(false);
    const approved = signal(false);
    const comments = signal(true);
    return (
      <Card title="Disabled" subtitle="A review bar the app locks: every item in it, link included" right={<Switch value={locked()} onChange={(v) => locked.set(v)} label="Lock" />}>
        <Toolbar accessibilityLabel="Review" disabled={locked()} style={{ ...track(), flexWrap: "wrap" }}>
          <Command icon="check" text="Approve" label="Approve" on={approved()} onPress={() => {
            approved.set(!approved());
            last.set(approved() ? "Approved" : "Approval withdrawn");
          }} />
          <Mark icon="message-circle" label="Show comments" pressed={comments()} onChange={(on) => {
            comments.set(on);
            last.set(`Comments: ${on ? "shown" : "hidden"}`);
          }} />
          <Rule />
          <ToolbarGroup accessibilityLabel="Share" disabled style={{ gap: 2 }}>
            <Command icon="share-2" label="Share (needs edit access)" onPress={() => {}} />
            <Command icon="download" label="Download (needs edit access)" onPress={() => {}} />
          </ToolbarGroup>
          <View style={{ flex: 1 }} />
          <Link
            href="https://nsh.dev/docs/review"
            openWith="app"
            onOpen={({ href }) => last.set(`Open: ${href}`)}
            style={{ paddingHorizontal: 8, height: TOOL.side, justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: "transparent", ...transition() }}
            hoverStyle={hovered()}
            focusStyle={focusRing(1)}
            disabledStyle={{ opacity: 0.35 }}
          >
            <Text style={{ fontSize: TOOL.text, color: colors.accent, textDecorationLine: "underline" }}>Review guide</Text>
          </Link>
        </Toolbar>
        <Caption label={locked() ? "Locked: no presses, no Tab stop, dimmed for screen readers" : "The share group is disabled on its own; Tab skips it"} />
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

  return <DemoPage cards={[Formatting, Player, Palette, Disabled, Last]} />;
}
