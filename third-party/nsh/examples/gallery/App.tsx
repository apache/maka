import { effect, mount, Scroll, signal, Text, untracked, View } from "nsh";
import { Animated, createAnimatedValue, Easing } from "nsh/animated";
import { platform, windowSize } from "nsh/device";
import { isAvailable as hasWindow, Window } from "nsh/desktop";
import { NavPage, NavStack } from "nsh/base";
import { keymap } from "nsh/keymap";
import { Storage } from "nsh/storage";
import { Icon } from "./icons";
import { TitleBar } from "./TitleBar";
import { Toaster } from "./toast";
import { type DemoEntry, nav } from "./nav";
import { Appear, Badge, colors, desktop, header, IconTile, lazy, Logo, mono, PageHeader, Press, radius, SIDEBAR, sidebarOpen, ThemeToggle } from "./ui";

/** The demos, by what they show; each module loads when first shown (`lazy`). */
const groups: { title: string; demos: DemoEntry[] }[] = [
  {
    title: "Apps",
    demos: [
      { name: "Stocks", detail: "A live watchlist and a stock: candles, depth, the tape, a tick every 50 ms", icon: "stocks", screen: lazy(() => import("./demos/Stocks").then((m) => m.Stocks)) },
      { name: "AI Chat", detail: "Local Claude / Codex, streaming replies, web simulation", icon: "chat", screen: lazy(() => import("./demos/Chat").then((m) => m.Chat)) },
      { name: "Photos", detail: "A long recycled list: images, pull to refresh, paging", icon: "photos", screen: lazy(() => import("./demos/Photos").then((m) => m.Photos)) },
    ],
  },
  {
    title: "Layout and lists",
    demos: [
      { name: "Lists", detail: "Columns, sticky sections, a chat, horizontal lists", icon: "lists", screen: lazy(() => import("./demos/Lists").then((m) => m.Lists)) },
      { name: "Scrolling", detail: "Paging, snapping, zoom, scroll events, prepending, keyboard taps", icon: "scroll", screen: lazy(() => import("./demos/Scrolling").then((m) => m.Scrolling)) },
      { name: "Collapsing header", detail: "A header that shrinks to a bar as the page scrolls, headings sticking below it", icon: "scroll", screen: lazy(() => import("./demos/CollapsingHeader").then((m) => m.CollapsingHeader)) },
      { name: "Navigation", detail: "Header options, modals, the back button, safe areas", icon: "nav", screen: lazy(() => import("./demos/Navigation").then((m) => m.Navigation)) },
      { name: "Form", detail: "Inputs, keyboard types, the keyboard over the content", icon: "form", screen: lazy(() => import("./demos/Form").then((m) => m.Form)) },
      { name: "Resizable", detail: "Panels resized by dragging the lines between them, within their ranges", icon: "sidebar", screen: lazy(() => import("./demos/Resizable").then((m) => m.Resizable)) },
      { name: "Dock", detail: "A workspace of tabs dragged between groups and docks, split, closed, zoomed and resized", icon: "components", screen: lazy(() => import("./demos/Dock").then((m) => m.Dock)) },
    ],
  },
  {
    title: "Touch and motion",
    demos: [
      { name: "Gestures", detail: "Pinch, rotate, press states, hit slop, pointer events", icon: "gestures", screen: lazy(() => import("./demos/Gestures").then((m) => m.Gestures)) },
      { name: "Physics", detail: "Drags and springs on the UI thread", icon: "physics", screen: lazy(() => import("./demos/Physics").then((m) => m.Physics)) },
      { name: "Animations", detail: "Easing, sequence / parallel / stagger / loop, springs, interpolation", icon: "animation", screen: lazy(() => import("./demos/Animations").then((m) => m.Animations)) },
    ],
  },
  {
    title: "Drawing and type",
    demos: [
      { name: "Canvas", detail: "2D context: paths, gradients, text, images, native animation", icon: "canvas", screen: lazy(() => import("./demos/CanvasDemo").then((m) => m.CanvasDemo)) },
      { name: "Styles", detail: "Corners, borders, shadows, clipping, 3D transforms", icon: "styles", screen: lazy(() => import("./demos/Styles").then((m) => m.Styles)) },
      { name: "Tailwind", detail: "class=\"…\" resolved natively: variants, grid, shadows, motion", icon: "tailwind", screen: lazy(() => import("./demos/Tailwind").then((m) => m.Tailwind)) },
      { name: "Text", detail: "Fonts, spans, inline views and images, decorations, truncation, languages", icon: "text", screen: lazy(() => import("./demos/TextDemo").then((m) => m.TextDemo)) },
      { name: "Text View", detail: "Markdown and HTML documents, extensions, streaming replies", icon: "text", screen: lazy(() => import("./demos/TextViewDemo").then((m) => m.TextViewDemo)) },
      { name: "Images", detail: "Resize modes, tint, GIF / WebP, placeholders, blur, fade", icon: "image", screen: lazy(() => import("./demos/Images").then((m) => m.Images)) },
    ],
  },
  {
    title: "Platform",
    demos: [
      { name: "Components", detail: "Press feedback, a sheet, layout animation, input accessory, dialog options", icon: "components", screen: lazy(() => import("./demos/Components").then((m) => m.Components)) },
      { name: "Overlays", detail: "Overlay, popovers, tooltips, sheets, toasts", icon: "components", screen: lazy(() => import("./demos/Overlays").then((m) => m.Overlays)) },
      { name: "Menus", detail: "A menu bar, submenus, checkable items, context menus on rows, a scrolling menu", icon: "lists", screen: lazy(() => import("./demos/Menus").then((m) => m.Menus)) },
      { name: "Controls", detail: "Switches in settings, a filter with select all, a plan picker, tabs, collapsible sections, progress bars", icon: "controls", screen: lazy(() => import("./demos/Controls").then((m) => m.Controls)) },
      { name: "Web and video", detail: "WKWebView / WebView, AVPlayer / MediaPlayer", icon: "media", screen: lazy(() => import("./demos/Media").then((m) => m.Media)) },
      { name: "System", detail: "Status bar, alerts, action sheets, environment, timers, fetch", icon: "system", screen: lazy(() => import("./demos/System").then((m) => m.System)) },
      { name: "Standard APIs", detail: "Files, processes, TCP, WebSockets, buffers, crypto and utilities", icon: "system", screen: lazy(() => import("./demos/Standard").then((m) => m.StandardDemo)) },
      { name: "Storage", detail: "nsh/storage: a launch count, a note saved as you type, the stored keys", icon: "storage", screen: lazy(() => import("./demos/Storage").then((m) => m.StorageDemo)) },
    ],
  },
];

function DemoRow(props: { demo: DemoEntry; first: boolean }) {
  return (
    <Press onPress={() => nav.push({ name: "demo", demo: props.demo })} scale={0.98} accessibilityLabel={props.demo.name}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderTopWidth: props.first ? 0 : 1,
          borderTopColor: colors.line,
        }}
      >
        <IconTile name={props.demo.icon} size={38} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 16, fontWeight: "500", color: colors.text }}>{props.demo.name}</Text>
          <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>
            {props.demo.detail}
          </Text>
        </View>
        <Icon name="chevron" size={16} tint={colors.faint} />
      </View>
    </Press>
  );
}

function Home() {
  return (
    <NavPage title="Gallery" {...header} headerRight={<ThemeToggle bar />} header={<PageHeader title="Gallery" root right={<ThemeToggle />} />}>
      <Scroll style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ padding: 16, paddingBottom: 40, gap: 20 }}>
          <Each of={groups}>
            {(group, g) => (
              <Appear index={g() + 1}>
                <View style={{ gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", paddingHorizontal: 4 }}>
                    <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.muted, letterSpacing: 0.4 }}>
                      {group().title.toUpperCase()}
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{group().demos.length}</Text>
                  </View>
                  <View
                    style={{
                      backgroundColor: colors.surface,
                      borderRadius: radius.card,
                      borderCurve: "continuous",
                      borderWidth: 1,
                      borderColor: colors.border,
                      overflow: "hidden",
                    }}
                  >
                    <Each of={group().demos}>{(demo, i) => <DemoRow demo={demo()} first={i() === 0} />}</Each>
                  </View>
                </View>
              </Appear>
            )}
          </Each>
        </View>
      </Scroll>
    </NavPage>
  );
}

/** The phone layout: the index, demos pushed over it. */
function Phone() {
  // Back from the desktop layout: the demo it showed stays open.
  if (untracked(wasDesktop)) nav.setRoutes([untracked(nav.routes)[0], { name: "demo", demo: untracked(selected) }]);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => {
        switch (route.name) {
          case "home":
            return <Home />;
          case "demo": {
            const Demo = route.demo.screen;
            return (
              <NavPage title={route.demo.name} {...header} header={<PageHeader title={route.demo.name} />}>
                <View style={{ flex: 1, backgroundColor: colors.background }}>
                  <Demo />
                </View>
              </NavPage>
            );
          }
          case "page": {
            const Page = route.page;
            return <Page />;
          }
        }
      }}
    </NavStack>
  );
}

/** The demo the desktop layout shows. */
const selected = signal<DemoEntry>(groups[0].demos[0]);
/** Whether the desktop layout has been shown (for the switch back). */
const wasDesktop = signal(false);

/** Shows a demo in the desktop layout, closing what it had pushed. */
const select = (demo: DemoEntry) => {
  if (nav.routes().length > 1) nav.popToRoot();
  selected.set(demo);
};

/** A demo in the sidebar: an accent bar and a raised fill when selected,
 * a fill under the pointer otherwise. */
function SidebarRow(props: { demo: DemoEntry }) {
  const active = () => selected().name === props.demo.name;
  return (
    <View
      onPress={() => select(props.demo)}
      role="button"
      accessibilityLabel={props.demo.name}
      accessibilityState={{ selected: active() }}
      class={active() ? "bg-accent" : "hover:bg-hover active:bg-accent"}
      style={{ height: 36, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, borderRadius: radius.control, cursor: "pointer" }}
    >
      <View style={{ position: "absolute", left: 0, top: 9, width: 3, height: 18, borderRadius: 1.5, backgroundColor: colors.accent, opacity: active() ? 1 : 0 }} />
      <Icon name={props.demo.icon} size={17} tint={active() ? colors.accent : colors.muted} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: active() ? "600" : "400", color: active() ? colors.text : colors.muted }}>
        {props.demo.name}
      </Text>
    </View>
  );
}

/** Hides or shows the desktop layout's sidebar: the content pane takes its
 * place at once, the sidebar slides away over it (or in, the pane making
 * room first), so no gap shows while it moves. */
const toggleSidebar = () => sidebarOpen.set(!untracked(sidebarOpen));

/** The title bar's button that hides and shows the sidebar, where desktop
 * apps put it: at the title bar's leading edge, after the logo. */
function SidebarToggle() {
  return (
    <View
      onPress={toggleSidebar}
      role="button"
      accessibilityLabel="Toggle sidebar"
      accessibilityState={{ selected: sidebarOpen() }}
      class="hover:bg-hover active:bg-accent"
      style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radius.control, cursor: "pointer" }}
    >
      <Icon name="sidebar" size={18} tint={colors.muted} />
    </View>
  );
}

/** The desktop layout's sidebar: the app, the demos by group, the window.
 * Its place in the row changes at once (0 pt collapsed); the panel slides
 * natively, over the content pane. */
function Sidebar() {
  const slide = createAnimatedValue(untracked(sidebarOpen) ? 0 : -SIDEBAR);
  let first = true;
  effect(() => {
    const open = sidebarOpen();
    if (first) {
      first = false;
      return;
    }
    Animated.timing(slide, { toValue: open ? 0 : -SIDEBAR, duration: 220, easing: Easing.out(Easing.cubic) }).start();
  });
  return (
    <View style={{ width: sidebarOpen() ? SIDEBAR : 0, flexShrink: 0, zIndex: 1 }}>
      <View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: SIDEBAR,
          transform: [{ translateX: slide }],
          backgroundColor: colors.inset,
          borderRightWidth: 1,
          borderRightColor: colors.line,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 }}>
          <Logo size={32} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>Gallery</Text>
            <Text style={{ fontSize: 12, color: colors.muted }}>NSH · {platform.os}</Text>
          </View>
          <ThemeToggle />
        </View>
        <Scroll style={{ flex: 1 }}>
          <View style={{ paddingHorizontal: 12, paddingBottom: 16 }}>
            <Each of={groups}>
              {(group) => (
                <View style={{ gap: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: colors.faint, letterSpacing: 0.6, paddingHorizontal: 10, paddingTop: 16, paddingBottom: 6 }}>
                    {group().title.toUpperCase()}
                  </Text>
                  <Each of={group().demos}>{(demo) => <SidebarRow demo={demo()} />}</Each>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
        <View style={{ paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line, gap: 2 }}>
          <Text style={{ fontSize: 12, color: colors.muted, fontFamily: mono }}>
            {Math.round(windowSize().width)} × {Math.round(windowSize().height)} pt
          </Text>
          <Text style={{ fontSize: 11, color: colors.faint }}>Narrower than 700 pt: the phone layout</Text>
        </View>
      </View>
    </View>
  );
}

/** The selected demo under a toolbar with its name and what it shows. */
function DemoPane() {
  const group = () => groups.find((g) => g.demos.some((demo) => demo.name === selected().name))?.title ?? "Gallery";
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ height: 64, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <IconTile name={selected().icon} size={36} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 18, fontWeight: "600", color: colors.text }}>
            {selected().name}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted }}>
            {selected().detail}
          </Text>
        </View>
        <Badge label={group()} />
      </View>
      <View style={{ flex: 1 }}>
        {(() => {
          const Demo = selected().screen;
          return <Demo />;
        })()}
      </View>
    </View>
  );
}

/**
 * The desktop layout: a sidebar of the demos and the selected one beside
 * it, no index to go back to. What a demo pushes opens over it in the
 * content pane, with a back button.
 */
function Desktop() {
  // From the phone layout: show the demo it had open.
  const routes = untracked(nav.routes);
  const open = routes.find((r) => r.name === "demo");
  if (open) selected.set(open.demo);
  if (routes.length > 1) nav.setRoutes([routes[0]]);
  wasDesktop.set(true);
  keymap.bind("mod+b", toggleSidebar);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.inset }}>
      <Sidebar />
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => {
          if (route.name !== "page") {
            return (
              <NavPage headerVisible={false}>
                <DemoPane />
              </NavPage>
            );
          }
          const Page = route.page;
          return <Page />;
        }}
      </NavStack>
    </View>
  );
}

/** The key of the demo left open, shown again on the next launch. */
const LAST_DEMO = "lastDemo";

/**
 * Reopens the demo left open last time (selected on a desktop, pushed on
 * a phone), then keeps the key current: the demo shown, or none when a
 * phone is back on the index. A name no demo has any more is ignored.
 */
function rememberDemo() {
  const restored = signal(false);
  let asked = false;
  effect(() => {
    // Once the window has its size, so the layout is the one that stays
    // (a demo pushed in the phone layout would open again in the desktop's).
    if (asked || windowSize().width === 0) return;
    asked = true;
    Storage.getItem(LAST_DEMO)
      .then((name) => {
        const demo = groups.flatMap((g) => g.demos).find((d) => d.name === name);
        // Only on a fresh start: not over what the user already opened.
        if (demo && untracked(nav.routes).length === 1) {
          if (untracked(desktop)) selected.set(demo);
          else nav.push({ name: "demo", demo });
        }
      })
      .finally(() => restored.set(true));
  });
  effect(() => {
    const open = desktop() ? selected() : nav.routes().find((r) => r.name === "demo")?.demo;
    if (!restored()) return;
    if (open) Storage.setItem(LAST_DEMO, open.name);
    else Storage.removeItem(LAST_DEMO);
  });
}

function App() {
  if (hasWindow) {
    Window.setTitle("Gallery");
    Window.setTitleBar("hidden", 40);
  }
  rememberDemo();
  return (
    <View style={{ flex: 1, backgroundColor: colors.inset }}>
      <TitleBar
        leading={
          <If when={desktop()}>
            <SidebarToggle />
          </If>
        }
      />
      <If when={desktop()} else={<Phone />}>
        <Desktop />
      </If>
      <Toaster />
    </View>
  );
}

mount(App);
