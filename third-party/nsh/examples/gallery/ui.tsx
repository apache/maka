// Gallery shell and navigation. Reusable components and visual rules live
// in the repository's internal nsh-gallery-ui layer.
import type { Bounds, JSX, ScrollProps } from "nsh";
import { Canvas, computed, Image, Scroll, signal, Text, View } from "nsh";
import { platform, setColorScheme, windowSize } from "nsh";
import { alpha, Appear, Button, colors, focusedSection, hovered, Icon, type IconName, isDark, Press, radius, TERMINAL_COLUMN, TERMINAL_GAP, TERMINAL_ROW, terminal, Tip } from "../nsh-gallery-ui";
import { nav, shownDemo } from "./nav";
import { play, setSoundsOn, soundsOn } from "../nsh-gallery-ui/sound";
import logoDark from "./logo-dark.svg";
import logoLight from "./logo-light.svg";

export * from "../nsh-gallery-ui";

/**
 * A page's header where the app draws it (desktops, the web: `<NavPage
 * header>`): a back button while the page is above another, the title, and
 * `right`, on one row in the terminal. Phones show their system header with
 * the page's `title` instead.
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
  /** The back button's color (default the text's). */
  tint?: string;
  /** Over the content (a transparent header): no fill, no hairline. */
  transparent?: boolean;
}) {
  const back = () => !props.left && !props.root && nav.routes().length > 1;
  const tint = () => props.tint ?? colors.text;
  const goBack = () => (props.onBack ? props.onBack() : nav.pop());
  if (terminal) {
    // One row, then the rule on a row of its own.
    return (
      <View style={{ height: 2 * TERMINAL_ROW, borderBottomWidth: props.transparent || props.background ? 0 : 1, borderBottomColor: colors.line, backgroundColor: props.transparent ? "transparent" : (props.background ?? colors.background) }}>
        <View style={{ height: TERMINAL_ROW, flexDirection: "row", alignItems: "center", gap: TERMINAL_GAP, paddingHorizontal: TERMINAL_COLUMN }}>
          {props.left}
          <If when={back()}>
            <Button label="Back" variant="secondary" onPress={goBack} />
          </If>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
            {props.center ?? <Text style={{ numberOfLines: 1, flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{props.title}</Text>}
          </View>
          {props.right}
        </View>
      </View>
    );
  }
  return (
    <View
      style={{
        height: 44,
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
          onPress={goBack}
          role="button"
          accessibilityLabel="Back"
          hitSlop={6}
          class="hover:bg-hover active:bg-accent"
          style={{ height: 28, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 8, borderRadius: radius.control, cursor: "pointer" }}
        >
          <Icon name="back" size={18} tint={tint()} />
          <Text style={{ fontSize: 13, fontWeight: "500", color: tint() }}>Back</Text>
        </View>
      </If>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: back() || props.left ? 0 : 4 }}>
        {props.center ?? (
          <Text style={{ numberOfLines: 1, flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>
            {props.title}
          </Text>
        )}
      </View>
      {props.right}
    </View>
  );
}

/** The width of the desktop layout's sidebar. */
export const SIDEBAR = 232;

/**
 * Whether the gallery takes its desktop layout: a sidebar of the demos next
 * to the open one, demos in columns, hover states. Desktops and terminals
 * take it from 700 pt wide, other platforms from 900 pt (an iPad in
 * landscape, a wide Mac Catalyst window); phones never do. Below that it is the phone layout,
 * unchanged. The shell remounts when it changes, so demos read it once.
 */
export const desktop = computed(() => windowSize().width >= (platform.desktop ? 700 : 900));

/** Whether the desktop layout shows its sidebar (the toggle in the demo's
 * toolbar and Ctrl+B / Cmd+B hide and show it; kept while the app runs). */
export const sidebarOpen = signal(true);

/** The width of the desktop layout's content pane, right of the sidebar. */
export const paneWidth = () => windowSize().width - (sidebarOpen() ? SIDEBAR : 0);

/** How many columns at least `min` pt wide fit in `width` (the content
 * pane by default), with `gap` between them and 32 pt gutters: 1 to `max`. */
export const columnsFor = (min: number, max: number, width = paneWidth(), gap = 20) =>
  Math.max(1, Math.min(max, Math.floor((width - 64 + gap) / (min + gap))));

/** Switches the app between light and dark (`setColorScheme`), whatever the system shows. */
export function ThemeToggle(props: { bar?: boolean }) {
  // In the system's bar (iOS, Android) the system draws the button (iOS's
  // Liquid Glass): the item is the icon alone.
  if (props.bar) {
    return (
      <Press
        onPress={() => {
          play("toggle", { rate: isDark() ? 1 : 0.9 });
          setColorScheme(isDark() ? "light" : "dark");
        }}
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
    <ToolButton
      icon={isDark() ? "sun" : "moon"}
      label={isDark() ? "Light appearance" : "Dark appearance"}
      title="Theme"
      onPress={() => {
          play("toggle", { rate: isDark() ? 1 : 0.9 });
          setColorScheme(isDark() ? "light" : "dark");
        }}
    />
  );
}

/** Turns the gallery's sounds on and off: the switch sounds as it turns on,
 * and once more, lower, as it turns off. */
export function SoundToggle(props: { bar?: boolean }) {
  const label = () => (soundsOn() ? "Mute sounds" : "Turn sounds on");
  const flip = () => {
    if (soundsOn()) {
      play("toggle", { rate: 0.9 });
      setSoundsOn(false);
    } else {
      setSoundsOn(true);
      play("toggle");
    }
  };
  if (props.bar) {
    return (
      <Press onPress={flip} scale={0.92} accessibilityLabel={label()}>
        <View style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }}>
          <Icon name={soundsOn() ? "volume-high" : "volume-off"} size={18} tint={colors.text} />
        </View>
      </Press>
    );
  }
  return <ToolButton icon={soundsOn() ? "volume-high" : "volume-off"} label={label()} title="Sound" onPress={flip} />;
}

/**
 * A quiet icon button of the window's toolbars and the sidebar (28 pt, a
 * fill under the pointer and while pressed, `on` while what it toggles is
 * shown). `label` names it for screen readers and its tooltip, `shortcut`
 * (a key's label) follows it there. The terminal shows a text button
 * reading `title` (a word or two), else `label`.
 */
export function ToolButton(props: { icon: IconName; label: string; title?: string; shortcut?: string; on?: boolean; onPress: () => void }) {
  if (terminal) {
    return <Button label={props.title ?? props.label} accessibilityLabel={props.label} variant="ghost" selected={props.on} onPress={props.onPress} />;
  }
  return (
    <View
      onPress={props.onPress}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      tooltip={<Tip label={props.label} shortcut={props.shortcut} />}
      hoverStyle={hovered()}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.09) }}
      style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radius.control }}
    >
      <Icon name={props.icon} size={16} tint={colors.muted} />
    </View>
  );
}

/** NSH's mark, sharp at any size, in the appearance shown (its dot is dark
 * on light backgrounds); none in the terminal. */
/** The index's opening, in the banner's composition: the mark, the name and
 * its slogan in citrus, over the banner's halftone fading in from the top
 * right. Text only in the terminal, which has no canvas to draw dots on. */
export function Banner() {
  return (
    <View style={{ marginHorizontal: 16, paddingHorizontal: 20, paddingVertical: 22, gap: 14, borderRadius: 16, borderCurve: "continuous", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
      {!terminal && (
        <Canvas
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          draw={(cx, { width, height }) => {
            const cell = 12;
            const dot = alpha(colors.text, isDark() ? 0.3 : 0.24);
            const lit = colors.accent;
            for (let y = cell / 2; y < height; y += cell) {
              for (let x = cell / 2; x < width; x += cell) {
                // Strongest at the top right, gone before the copy.
                const d = Math.hypot((width - x) / (width * 0.75), y / (height * 1.3));
                const k = 1 - d;
                if (k <= 0) continue;
                const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
                const r = (0.5 + 1.9 * k) * (0.55 + 0.45 * (n - Math.floor(n)));
                cx.fillStyle = (n - Math.floor(n)) > 0.95 && k > 0.45 ? lit : dot;
                cx.beginPath();
                cx.arc(x, y, r, 0, Math.PI * 2);
                cx.fill();
              }
            }
          }}
        />
      )}
      <Logo size={44} />
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 28, fontWeight: "600", letterSpacing: -0.6, color: colors.text }}>Native Shell</Text>
        <Text style={{ fontSize: 16, color: colors.accent }}>Build once, native everywhere</Text>
      </View>
      <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>Every demo here is native UI from one TSX app, on {platformNames}.</Text>
    </View>
  );
}

const platformNames = "macOS, Windows, Linux, iOS, Android, the web and the terminal";

export function Logo(props: { size: number }) {
  if (terminal) return null;
  return <Image src={isDark() ? logoDark : logoLight} style={{ width: props.size, height: props.size }} />;
}

/**
 * The head of a demo's page: its name as the title (the desktop layout; the
 * phone's bar shows it there) and what it shows as the lead.
 */
function DemoHead() {
  return (
    <If when={shownDemo()}>
      <View style={{ gap: terminal ? 0 : 4 }}>
        <If when={desktop()}>
          <Text style={{ fontSize: 20, fontWeight: "600", color: colors.text, letterSpacing: -0.2 }}>{shownDemo()!.name}</Text>
        </If>
        <Text style={{ fontSize: desktop() ? 13 : 15, lineHeight: desktop() ? 18 : 21, color: colors.muted }}>{shownDemo()!.detail}</Text>
      </View>
    </If>
  );
}

/**
 * A demo's page: its head, then its sections, each fading in after the one
 * before. On phones one column on 16 pt gutters, 28 pt between sections; in
 * the desktop layout the sections are dealt left to right into as many
 * columns as fit the pane (at least 360 pt each, `columns` at most), on
 * 32 pt gutters with 20 pt between columns and 24 between sections. The
 * terminal's gutters are a Cell wide, its spaces whole rows.
 * `children` follow the sections inside the scroll view (a demo's modals).
 *
 * With `lazy` (a long page of heavy sections) a section is made only once it
 * comes near the screen, a quarter of the screen ahead of it, and fades in
 * then; below that it is a space of `estimatedCardHeight`. Once made it
 * stays, so it keeps its state, its timers run on and nothing draws in
 * again when it scrolls back. One section shown (`focusedSection`) makes it
 * at once, as without `lazy`.
 */
export function DemoPage(props: {
  cards: (() => JSX.Element)[];
  /** Whether the sections are made as they scroll near (default false). */
  lazy?: boolean;
  /** The space a section takes before it is made, with `lazy` (default 360). */
  estimatedCardHeight?: number;
  /** The most columns on a desktop (default 2). */
  columns?: number;
  /** Space under the last section on phones (default 40). */
  bottom?: number;
  /** Whether the sections fade in (default true). */
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
  // One section shown (`focusedSection`) takes the pane's width.
  const columns = computed(() => (focusedSection() == null ? columnsFor(360, props.columns ?? 2) : 1));
  const defer = props.lazy === true && focusedSection() == null ? deferred(props.cards.length, wide ? columns() : 1, props.estimatedCardHeight ?? 360, wide ? 24 : 28) : null;
  const slot = (Body: () => JSX.Element, index: number) => (defer ? defer.slot(index, (stagger) => card(Body, stagger)) : card(Body, index));
  // The desktop's cards are made once and moved between the columns when
  // their count changes (a window resized), so what they hold (an open
  // sheet, a field's text, a list's scroll) stays.
  const made = wide ? props.cards.map((body, i) => slot(body, i)) : [];
  return (
    <Scroll
      style={{ flex: 1, backgroundColor: colors.background }}
      keyboardDismissMode={props.keyboardDismissMode}
      keyboardShouldPersistTaps={props.keyboardShouldPersistTaps}
      onLayout={defer?.onViewport}
      onScroll={defer?.onScroll}
    >
      <If
        when={wide}
        else={
          <View style={terminal ? { paddingHorizontal: TERMINAL_COLUMN, paddingVertical: TERMINAL_ROW, gap: TERMINAL_ROW } : { paddingHorizontal: 16, paddingTop: 12, paddingBottom: props.bottom ?? 40, gap: 28 }}>
            <View style={{ paddingHorizontal: terminal ? 0 : 4 }}>
              <DemoHead />
            </View>
            <Each of={props.cards}>{(body, i) => slot(body(), i())}</Each>
          </View>
        }
      >
        {(() => {
          const n = columns();
          // Left-aligned under the toolbar's breadcrumb; one column reads as
          // a document, at most a comfortable line's width.
          return (
            <View
              style={[
                // A terminal's columns take the pane's width: its Cells are the
                // density, and a cap would leave a band of blank columns.
                { width: "100%", maxWidth: n === 1 ? 880 : terminal ? undefined : n * 540 + 64 },
                // A blank column on either side: the scroll bar, when there
                // is one, takes a column of its own past it.
                terminal
                  ? { paddingHorizontal: TERMINAL_COLUMN, paddingVertical: TERMINAL_ROW, gap: TERMINAL_ROW }
                  : { paddingHorizontal: 32, paddingTop: 24, paddingBottom: 48, gap: 24 },
              ]}
            >
              <DemoHead />
              {/* Two columns between cards in the terminal (from 24pt): a
                  card's header caption is not read as the next card's. */}
              <View onLayout={defer?.onColumns} style={{ flexDirection: "row", alignItems: "flex-start", gap: terminal ? 3 * TERMINAL_COLUMN : 20 }}>
                {Array.from({ length: n }, (_, column) => (
                  <View style={{ flex: 1, minWidth: 0, gap: terminal ? TERMINAL_ROW : 24 }}>{made.map((element, i) => (i % n === column ? element : null))}</View>
                ))}
              </View>
            </View>
          );
        })()}
      </If>
      {props.children}
    </Scroll>
  );
}

/**
 * What `DemoPage`'s `lazy` keeps: which sections are made, and where the
 * others lie against the screen. A section's place is its slot's top in
 * its column (the page's content on phones), plus the columns' top on the
 * desktop. Each scroll and layout report makes the sections that came
 * within a quarter of the screen of its bottom, in order; those made
 * together fade in one after another, as the page's first ones do.
 */
function deferred(count: number, columns: number, estimate: number, gap: number) {
  // Null while not made, then the index its fade waits for.
  const made = Array.from({ length: count }, () => signal<number | null>(null));
  const tops: (number | undefined)[] = new Array(count).fill(undefined);
  let base = 0;
  let offset = 0;
  let viewport = windowSize().height;
  let left = count;
  // The first screen is made with the page, from the estimate: rows of
  // `columns` sections, `estimate` tall, from the top.
  for (let i = 0; i < count; i++) {
    if (Math.floor(i / columns) * (estimate + gap) < viewport) {
      made[i].set(i);
      left--;
    }
  }
  const check = () => {
    if (left === 0) return;
    const limit = offset + viewport * 1.25;
    let batch = 0;
    for (let i = 0; i < count; i++) {
      const top = tops[i];
      if (top === undefined || made[i]() != null) continue;
      if (base + top < limit) {
        made[i].set(batch++);
        left--;
      }
    }
  };
  return {
    onViewport: ({ bounds }: { bounds: Bounds }) => {
      viewport = bounds.size.height;
      check();
    },
    onScroll: (e: { offset: { y: number } }) => {
      offset = e.offset.y;
      check();
    },
    onColumns: ({ bounds }: { bounds: Bounds }) => {
      base = bounds.origin.y;
      check();
    },
    slot: (index: number, render: (stagger: number) => JSX.Element) => (
      <View
        onLayout={({ bounds }) => {
          tops[index] = bounds.origin.y;
          check();
        }}
        style={{ height: made[index]() == null ? estimate : undefined }}
      >
        <If when={made[index]() != null}>{render(made[index]()!)}</If>
      </View>
    ),
  };
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
