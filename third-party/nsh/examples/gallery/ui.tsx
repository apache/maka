// Gallery shell and navigation. Reusable components and visual rules live
// in the repository's internal nsh-gallery-ui layer.
import type { JSX, ScrollProps } from "nsh";
import { computed, Image, Scroll, signal, Text, View } from "nsh";
import { platform, setColorScheme, windowSize } from "nsh";
import { Appear, colors, Icon, isDark, Press, radius, RoundButton } from "../nsh-gallery-ui";
import { nav } from "./nav";
import logoDark from "./logo-dark.svg";
import logoLight from "./logo-light.svg";

export * from "../nsh-gallery-ui";

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
