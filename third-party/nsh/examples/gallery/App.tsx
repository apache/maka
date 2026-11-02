import { type Bounds, computed, effect, type InputRef, mount, Scroll, signal, Text, untracked, View, type ScrollRef } from "nsh";
import { Animated, createAnimatedValue, Easing } from "nsh";
import { platform, windowSize } from "nsh";
import { isAvailable as hasWindow, titleBar, Window } from "nsh/desktop";
import { Input, NavPage, NavStack, Scrollbar } from "nsh/base";
import { keymap } from "nsh";
import { Storage } from "nsh";
import { Icon } from "./icons";
import { TitleBar } from "./TitleBar";
import { Toaster } from "./toast";
import { type DemoEntry, nav, shownDemo } from "./nav";
import { field } from "../nsh-gallery-ui/demo";
import { Appear, colors, desktop, focusRing, header, hovered, IconTile, lazy, Logo, PageHeader, Press, scrollbarTheme, SIDEBAR, sidebarOpen, ThemeToggle, ToolButton } from "./ui";

/** `nsh`'s primitives, from the simplest, in the website's order. */
const primitives: DemoEntry[] = [
  { name: "Text", detail: "Fonts, spans, inline views and images, decorations, truncation, languages", icon: "text", screen: lazy(() => import("./demos/TextDemo").then((m) => m.TextDemo)) },
  { name: "Image", detail: "Resize modes, tint, GIF / WebP, placeholders, blur, fade", icon: "image", screen: lazy(() => import("./demos/Images").then((m) => m.Images)) },
  { name: "Scroll", detail: "Paging, snapping, zoom, scroll events, prepending, keyboard taps", icon: "scroll", screen: lazy(() => import("./demos/Scrolling").then((m) => m.Scrolling)) },
  { name: "List", detail: "Columns, sticky sections, a chat, horizontal lists", icon: "lists", screen: lazy(() => import("./demos/Lists").then((m) => m.Lists)) },
  { name: "Canvas", detail: "2D context: paths, gradients, text, images, native animation", icon: "canvas", screen: lazy(() => import("./demos/CanvasDemo").then((m) => m.CanvasDemo)) },
  { name: "Shader", detail: "WGSL shaders on the GPU: noise, gradients, animated uniforms", icon: "spark", screen: lazy(() => import("./demos/Shaders").then((m) => m.Shaders)) },
  { name: "WebView and Video", detail: "WKWebView / WebView, AVPlayer / MediaPlayer", icon: "media", screen: lazy(() => import("./demos/Media").then((m) => m.Media)) },
  { name: "Overlay", detail: "Content on top of the screen, outside the box that clips it", icon: "layers", screen: lazy(() => import("./demos/Overlays").then((m) => m.OverlayDemo)) },
];

/** `nsh/base`'s components, by name, as the website lists them
 * (`website/tests/elements.test.ts` holds both lists to the website). */
const components: DemoEntry[] = [
  { name: "Accordion", detail: "An FAQ one answer at a time, settings sections open together, controls and an accordion inside", icon: "collapsible", screen: lazy(() => import("./demos/AccordionDemo").then((m) => m.AccordionDemo)) },
  { name: "Avatar", detail: "A team with presence dots, a stacked group and its overflow, a comment thread, a profile, pictures that fail or load slowly", icon: "image", screen: lazy(() => import("./demos/AvatarDemo").then((m) => m.AvatarDemo)) },
  { name: "Button", detail: "Kinds and sizes, icon and split buttons, progress, copying, hold to confirm", icon: "button", screen: lazy(() => import("./demos/ButtonDemo").then((m) => m.ButtonDemo)) },
  { name: "Checkbox", detail: "A filter whose “Select all” shows a partial selection", icon: "checkbox", screen: lazy(() => import("./demos/Controls").then((m) => m.CheckboxDemo)) },
  { name: "Collapsible", detail: "Details under a summary, kept while collapsed", icon: "collapsible", screen: lazy(() => import("./demos/Controls").then((m) => m.CollapsibleDemo)) },
  { name: "ColorPicker", detail: "An area, sliders of RGB, HSL, HSB or OKLCH, a field and swatches", icon: "styles", screen: lazy(() => import("./demos/ColorPickerDemo").then((m) => m.ColorPickerDemo)) },
  { name: "Combobox", detail: "Topics picked several at once with search, a reviewer picked alone", icon: "select", screen: lazy(() => import("./demos/Controls").then((m) => m.ComboboxDemo)) },
  { name: "DataTable", detail: "A million stocks of sixty columns, their quotes ticking every 33 ms, fixed columns, sorting, selection, resized and moved columns", icon: "table", screen: lazy(() => import("./demos/DataTableDemo").then((m) => m.DataTableDemo)) },
  { name: "DatePicker", detail: "A due date on weekdays, a trip's range with presets, a meeting's day and time", icon: "select", screen: lazy(() => import("./demos/Controls").then((m) => m.DatePickerDemo)) },
  { name: "DiffView", detail: "Two texts side by side or unified, changes navigated, reverted and kept, a patch", icon: "diff", screen: lazy(() => import("./demos/DiffDemo").then((m) => m.DiffDemo)) },
  { name: "Dock", detail: "A workspace of tabs dragged between groups and docks, split, closed, zoomed and resized", icon: "dock", screen: lazy(() => import("./demos/Dock").then((m) => m.Dock)) },
  { name: "Editor", detail: "Code with highlighting, several carets, folding, find and replace, a language server: diagnostics, hover, definitions, completion", icon: "code", screen: lazy(() => import("./demos/EditorDemo").then((m) => m.EditorDemo)) },
  { name: "Input", detail: "Live validation, passwords, search, input groups, the keyboard over the content", icon: "form", screen: lazy(() => import("./demos/Form").then((m) => m.Form)) },
  { name: "Link", detail: "Links in a paragraph, a navigation the app routes, sites outside the app, a footer, visited and disabled", icon: "link", screen: lazy(() => import("./demos/LinkDemo").then((m) => m.LinkDemo)) },
  { name: "Menu", detail: "A menu bar, submenus, checkable items, context menus on rows, a scrolling menu", icon: "menu", screen: lazy(() => import("./demos/Menus").then((m) => m.Menus)) },
  { name: "NavStack", detail: "Header options, modals, the back button, safe areas", icon: "nav", screen: lazy(() => import("./demos/Navigation").then((m) => m.Navigation)) },
  { name: "NumberInput", detail: "Quantities typed or stepped, within a range, in steps", icon: "stepper", screen: lazy(() => import("./demos/Controls").then((m) => m.NumberInputDemo)) },
  { name: "OtpInput", detail: "A one-time code typed into one field, pasted or filled by the system", icon: "otp", screen: lazy(() => import("./demos/Controls").then((m) => m.OtpInputDemo)) },
  { name: "Pagination", detail: "Search results with a count, a table footer with its page size, a compact pager, ten thousand pages with jump menus", icon: "lists", screen: lazy(() => import("./demos/PaginationDemo").then((m) => m.PaginationDemo)) },
  { name: "Plot", detail: "A live price, an order book's depth, a drawdown, capacity rings, a donut and bars, built from plot parts", icon: "chart", screen: lazy(() => import("./demos/Charts").then((m) => m.Charts)) },
  { name: "Popover", detail: "A panel anchored to its trigger; a press outside, Escape or back closes it", icon: "popover", screen: lazy(() => import("./demos/Overlays").then((m) => m.PopoverDemo)) },
  { name: "Progress", detail: "A transfer the app drives, and one of unknown size", icon: "progress", screen: lazy(() => import("./demos/Controls").then((m) => m.ProgressDemo)) },
  { name: "Radio", detail: "A plan picker: one of a small set, a disabled plan", icon: "radio", screen: lazy(() => import("./demos/Controls").then((m) => m.RadioDemo)) },
  { name: "Resizable", detail: "Panels resized by dragging the lines between them, within their ranges", icon: "sidebar", screen: lazy(() => import("./demos/Resizable").then((m) => m.Resizable)) },
  { name: "RichEditor", detail: "A document editor on Tiptap's extensions: lists, links, tables, Markdown shortcuts, undo and redo", icon: "richtext", screen: lazy(() => import("./demos/RichEditorDemo").then((m) => m.RichEditorDemo)) },
  { name: "Select", detail: "A sort order, fonts in sections with search, a disabled language", icon: "select", screen: lazy(() => import("./demos/Controls").then((m) => m.SelectDemo)) },
  { name: "Sheet", detail: "A panel at an edge, over a backdrop; a swipe, the backdrop, Escape or back closes it", icon: "sheet", screen: lazy(() => import("./demos/Overlays").then((m) => m.SheetDemo)) },
  { name: "Slider", detail: "A level and a price range the app owns", icon: "sliders", screen: lazy(() => import("./demos/Controls").then((m) => m.SliderDemo)) },
  { name: "Switch", detail: "Settings that take effect at once, one that needs another on", icon: "switch", screen: lazy(() => import("./demos/Controls").then((m) => m.SwitchDemo)) },
  { name: "Tabs", detail: "A section switcher, a disabled tab", icon: "tabs", screen: lazy(() => import("./demos/Controls").then((m) => m.TabsDemo)) },
  { name: "TextView", detail: "Markdown and HTML documents, extensions, streaming replies", icon: "document", screen: lazy(() => import("./demos/TextViewDemo").then((m) => m.TextViewDemo)) },
  { name: "Toast", detail: "Notes that close by themselves, by their action, back or a swipe", icon: "bell", screen: lazy(() => import("./demos/Overlays").then((m) => m.ToastDemo)) },
  { name: "Toggle", detail: "A text toolbar, a segmented view switcher, a favorite star, sizes, a locked group", icon: "controls", screen: lazy(() => import("./demos/ToggleDemo").then((m) => m.ToggleDemo)) },
  { name: "Toolbar", detail: "A text editor's formatting bar, a media player's transport, a vertical tool palette, a locked review bar", icon: "sliders", screen: lazy(() => import("./demos/ToolbarDemo").then((m) => m.ToolbarDemo)) },
  { name: "Tooltip", detail: "A label while the pointer rests on an element, or pinned by the app", icon: "tooltip", screen: lazy(() => import("./demos/Overlays").then((m) => m.TooltipDemo)) },
];

/** The demos: the apps built on NSH, then one demo per element in the
 * website's order (`nsh`'s primitives, then `nsh/base`'s components), styling,
 * motion and the platform's APIs. Each module loads when first shown (`lazy`). */
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
    title: "Elements",
    demos: [...primitives, ...components],
  },
  {
    title: "Styling",
    demos: [
      { name: "Styles", detail: "Corners, borders, shadows, clipping, 3D transforms", icon: "styles", screen: lazy(() => import("./demos/Styles").then((m) => m.Styles)) },
      { name: "Tailwind", detail: "class=\"…\" resolved natively: variants, grid, shadows, motion", icon: "tailwind", screen: lazy(() => import("./demos/Tailwind").then((m) => m.Tailwind)) },
      { name: "Patterns", detail: "Press feedback, a sheet, layout animation, input accessory, dialog options", icon: "components", screen: lazy(() => import("./demos/Components").then((m) => m.Components)) },
    ],
  },
  {
    title: "Motion",
    demos: [
      { name: "Animations", detail: "Easing, sequence / parallel / stagger / loop, springs, interpolation", icon: "animation", screen: lazy(() => import("./demos/Animations").then((m) => m.Animations)) },
      { name: "Gestures", detail: "Pinch, rotate, press states, hit slop, pointer events", icon: "gestures", screen: lazy(() => import("./demos/Gestures").then((m) => m.Gestures)) },
      { name: "Physics", detail: "Drags and springs on the UI thread", icon: "physics", screen: lazy(() => import("./demos/Physics").then((m) => m.Physics)) },
      { name: "Collapsing header", detail: "A header that shrinks to a bar as the page scrolls, headings sticking below it", icon: "header", screen: lazy(() => import("./demos/CollapsingHeader").then((m) => m.CollapsingHeader)) },
    ],
  },
  {
    title: "Platform",
    demos: [
      { name: "System", detail: "Status bar, alerts, action sheets, environment, timers, fetch", icon: "system", screen: lazy(() => import("./demos/System").then((m) => m.System)) },
      { name: "Standard APIs", detail: "Files, processes, TCP, WebSockets, buffers, crypto and utilities", icon: "system", screen: lazy(() => import("./demos/Standard").then((m) => m.StandardDemo)) },
      { name: "Storage", detail: "nsh: a launch count, a note saved as you type, the stored keys", icon: "storage", screen: lazy(() => import("./demos/Storage").then((m) => m.StorageDemo)) },
    ],
  },
];

/** The subheadings Elements lists its demos under. */
const parts = new Map<DemoEntry, string>([...primitives.map((d) => [d, "Primitives"] as const), ...components.map((d) => [d, "Components"] as const)]);

/** A group's demos (all of them, or those the search found) in runs under
 * their subheadings: one run without a subheading outside Elements. */
function runs(demos: DemoEntry[]): { title?: string; demos: DemoEntry[] }[] {
  const out: { title?: string; demos: DemoEntry[] }[] = [];
  for (const demo of demos) {
    const title = parts.get(demo);
    if (out.length === 0 || out[out.length - 1].title !== title) out.push({ title, demos: [] });
    out[out.length - 1].demos.push(demo);
  }
  return out;
}

/** A demo of the phone's index: its icon, its name and one line of what it shows. */
function DemoRow(props: { demo: DemoEntry; first: boolean }) {
  return (
    <Press onPress={() => nav.push({ name: "demo", demo: props.demo })} scale={0.98} accessibilityLabel={props.demo.name}>
      <View style={{ minHeight: 60, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16 }}>
        <If when={!props.first}>
          <View style={{ position: "absolute", top: 0, left: 60, right: 0, height: 1, backgroundColor: colors.line }} />
        </If>
        <IconTile name={props.demo.icon} size={30} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "500", color: colors.text }}>{props.demo.name}</Text>
          <Text style={{ numberOfLines: 1, fontSize: 13, color: colors.muted }}>{props.demo.detail}</Text>
        </View>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </View>
    </Press>
  );
}

function Home() {
  return (
    <NavPage title="Gallery" {...header} headerLargeTitle headerRight={<ThemeToggle bar />} header={<PageHeader title="Gallery" root right={<ThemeToggle />} />}>
      <Scroll style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={{ paddingTop: 12, paddingBottom: 40, gap: 28 }}>
          <Each of={groups}>
            {(group, g) => (
              <Appear index={g()}>
                <View style={{ gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", paddingHorizontal: 20 }}>
                    <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.muted, letterSpacing: 0.3 }}>{group().title.toUpperCase()}</Text>
                    <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{group().demos.length}</Text>
                  </View>
                  <Each of={runs(group().demos)}>
                    {(run, r) => (
                      <>
                        <If when={run().title}>
                          {(title) => <Text style={{ fontSize: 13, fontWeight: "500", color: colors.muted, paddingHorizontal: 20, paddingTop: r() === 0 ? 0 : 8 }}>{title()}</Text>}
                        </If>
                        <View
                          style={{
                            marginHorizontal: 16,
                            backgroundColor: colors.surface,
                            borderRadius: 16,
                            borderCurve: "continuous",
                            borderWidth: 1,
                            borderColor: colors.border,
                            overflow: "hidden",
                          }}
                        >
                          <Each of={run().demos}>{(demo, i) => <DemoRow demo={demo()} first={i() === 0} />}</Each>
                        </View>
                      </>
                    )}
                  </Each>
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
  effect(() => shownDemo.set(nav.routes().find((r) => r.name === "demo")?.demo ?? null));
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

/** The platforms' names as people write them. */
const osName: Record<string, string> = { macos: "macOS", ios: "iOS", android: "Android", windows: "Windows", linux: "Linux", web: "Web" };

/** The demo the desktop layout shows. */
const selected = signal<DemoEntry>(groups[0].demos[0]);
/** Whether the desktop layout has been shown (for the switch back). */
const wasDesktop = signal(false);

/** Shows a demo in the desktop layout, closing what it had pushed. */
const select = (demo: DemoEntry) => {
  if (nav.routes().length > 1) nav.popToRoot();
  selected.set(demo);
};

/** What the sidebar's search field holds. */
const query = signal("");

/** The groups and demos whose name or group matches the search, groups left empty dropped. */
const found = computed(() => {
  const q = query().trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({ title: g.title, demos: g.title.toLowerCase().includes(q) ? g.demos : g.demos.filter((d) => d.name.toLowerCase().includes(q)) }))
    .filter((g) => g.demos.length > 0);
});

/** A demo in the sidebar: 28 pt, a fill under the pointer, a raised row with
 * an edge and the accent icon when selected, the focus ring too while the
 * list has the keyboard focus (`focused`). No stop of Tab: the list is. */
function SidebarRow(props: { demo: DemoEntry; focused: boolean; onLayout: (bounds: Bounds) => void }) {
  const active = () => selected().name === props.demo.name;
  return (
    <View
      onPress={() => select(props.demo)}
      focusable={false}
      onLayout={({ bounds }) => props.onLayout(bounds)}
      role="button"
      accessibilityLabel={props.demo.name}
      accessibilityState={{ selected: active() }}
      hoverStyle={active() ? undefined : hovered()}
      style={{
        height: 28,
        marginHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingHorizontal: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active() ? colors.border : "transparent",
        backgroundColor: active() ? colors.sidebarSelected : "transparent",
        boxShadow: active() ? "0 1px 0 rgba(0,0,0,0.04)" : undefined,
        ...(active() && props.focused ? focusRing() : {}),
      }}
    >
      <Icon name={props.demo.icon} size={15} tint={active() ? colors.accent : colors.muted} />
      <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, fontWeight: active() ? "500" : "400", color: colors.text }}>{props.demo.name}</Text>
    </View>
  );
}

/** Hides or shows the desktop layout's sidebar: the content pane takes its
 * place at once, the sidebar slides away over it (or in, the pane making
 * room first), so no gap shows while it moves. */
const toggleSidebar = () => sidebarOpen.set(!untracked(sidebarOpen));

/** The button that hides and shows the sidebar: at the sidebar's top row,
 * and in the toolbar while the sidebar is hidden. */
function SidebarToggle() {
  return <ToolButton icon="sidebar" label="Toggle sidebar" shortcut={keymap.label("mod+b")} on={sidebarOpen()} onPress={toggleSidebar} />;
}

/** The sidebar's search: filters the demos by name or group as you type
 * (Ctrl+K / Cmd+K focuses it, Escape clears it). */
function Search() {
  let input: InputRef | undefined;
  keymap.bind("mod+k", () => input?.focus());
  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
      <Input
        ref={(node) => (input = node)}
        {...field({ style: { paddingLeft: 26 } })}
        value={query()}
        onChange={({ value }) => query.set(value)}
        onKeyPress={(e) => e.key === "Escape" && query.set("")}
        placeholder={`Search demos  ${keymap.label("mod+k")}`}
        accessibilityLabel="Search demos"
      />
      <View style={{ position: "absolute", left: 20, top: 7, pointerEvents: "none" }}>
        <Icon name="search" size={14} tint={colors.faint} />
      </View>
    </View>
  );
}

/**
 * The sidebar's demos by group (those the search finds): one stop of Tab,
 * as a macOS source list is. While the list has the keyboard focus, Up and
 * Down select the demo before and after, Home and End the first and the
 * last, scrolled into view. Tab moves on past all of them, so the demo's
 * page is a few stops away rather than one per demo.
 */
function DemoList() {
  const focused = signal(false);
  let scroller: ScrollRef | undefined;
  // The offset and the height the list shows, and where each group and
  // each demo in its group is: what scrolls the selected demo into view.
  let offset = 0;
  let height = 0;
  const groupTops = new Map<string, number>();
  const rows = new Map<string, { group: string; bounds: Bounds }>();
  const reveal = (name: string) => {
    const row = rows.get(name);
    if (!row || !scroller) return;
    const top = (groupTops.get(row.group) ?? 0) + row.bounds.origin.y;
    const bottom = top + row.bounds.size.height;
    if (top < offset) scroller.scrollTo({ y: top, animated: true });
    else if (bottom > offset + height) scroller.scrollTo({ y: bottom - height, animated: true });
  };
  /** Selects the demo at `to(at, last)` of those shown: `at` the selected one's place (-1 when the search hides it). */
  const move = (to: (at: number, last: number) => number) => {
    const demos = found().flatMap((g) => g.demos);
    if (demos.length === 0) return;
    const at = demos.findIndex((d) => d.name === selected().name);
    const demo = demos[Math.min(Math.max(to(at, demos.length - 1), 0), demos.length - 1)];
    if (demo.name === selected().name) return;
    select(demo);
    reveal(demo.name);
  };
  // Bound only while the list has the focus: elsewhere the arrows are the
  // page's (a plot's, a scroll view's).
  effect(() => {
    if (!focused()) return;
    keymap.bind(
      {
        up: () => move((at) => at - 1),
        down: () => move((at) => at + 1),
        home: () => move(() => 0),
        end: () => move((_, last) => last),
      },
      { repeat: true },
    );
  });
  return (
    <Scroll
      ref={(node) => (scroller = node)}
      onLayout={({ bounds }) => (height = bounds.size.height)}
      onScroll={(e) => (offset = e.offset.y)}
      style={{ flex: 1 }}
    >
      <View focusable={true} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} style={{ paddingBottom: 12 }}>
        <Each of={found()}>
          {(group) => (
            <View onLayout={({ bounds }) => groupTops.set(group().title, bounds.origin.y)} style={{ gap: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.muted, letterSpacing: 0.4, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 }}>
                {group().title.toUpperCase()}
              </Text>
              <Each of={runs(group().demos)}>
                {(run, r) => (
                  <>
                    <If when={run().title}>
                      {(title) => <Text style={{ fontSize: 12, fontWeight: "500", color: colors.faint, paddingHorizontal: 20, paddingTop: r() === 0 ? 2 : 10, paddingBottom: 3 }}>{title()}</Text>}
                    </If>
                    <Each of={run().demos}>
                      {(demo) => <SidebarRow demo={demo()} focused={focused()} onLayout={(bounds) => rows.set(demo().name, { group: group().title, bounds })} />}
                    </Each>
                  </>
                )}
              </Each>
            </View>
          )}
        </Each>
        <If when={found().length === 0}>
          <Text style={{ fontSize: 12, color: colors.muted, paddingHorizontal: 20, paddingTop: 14 }}>No demo matches “{query().trim()}”</Text>
        </If>
      </View>
    </Scroll>
  );
}

/** The desktop layout's sidebar: the window's controls and the toggle, the
 * search, the demos by group, the app and its appearance. Its place in the
 * row changes at once (0 pt collapsed); the panel slides natively, over the
 * content pane. */
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
          translate: [slide, 0],
          backgroundColor: colors.sidebar,
          borderRightWidth: 1,
          borderRightColor: colors.sidebarBorder,
        }}
      >
        <View
          desktop={{ windowDrag: true }}
          style={{ height: 44, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingLeft: titleBar().left + 12, paddingRight: 10 }}
        >
          <SidebarToggle />
        </View>
        <Search />
        <DemoList />
        <View style={{ height: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 16, paddingRight: 10, borderTopWidth: 1, borderTopColor: colors.sidebarBorder }}>
          <Logo size={22} />
          <View style={{ flex: 1, gap: 0 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.text }}>Gallery</Text>
            <Text style={{ fontSize: 11, color: colors.muted }}>NSH · {osName[platform.os] ?? platform.os}</Text>
          </View>
          <ThemeToggle />
        </View>
      </View>
    </View>
  );
}

/** The selected demo under the window's toolbar: where it is (its group and
 * its name), and the sidebar's toggle while the sidebar is hidden. */
function DemoPane() {
  const group = () => groups.find((g) => g.demos.some((demo) => demo.name === selected().name))?.title ?? "Gallery";
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        desktop={{ windowDrag: true }}
        style={{
          height: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingLeft: sidebarOpen() ? 32 : titleBar().left + 12,
          paddingRight: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
        }}
      >
        <If when={!sidebarOpen()}>
          <View style={{ marginRight: 8 }}>
            <SidebarToggle />
          </View>
        </If>
        <Text style={{ fontSize: 13, color: colors.muted }}>{group()}</Text>
        <Icon name="chevron" size={12} tint={colors.faint} />
        <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>{selected().name}</Text>
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
  effect(() => shownDemo.set(selected()));
  keymap.bind("mod+b", toggleSidebar);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
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
    Window.setTitleBar({ style: "hidden", height: 44 });
  }
  rememberDemo();
  // Every scroll view and list draws the gallery's bar.
  Scrollbar.setTheme(scrollbarTheme);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <If when={!desktop()}>
        <TitleBar />
      </If>
      <If when={desktop()} else={<Phone />}>
        <Desktop />
      </If>
      <Toaster />
    </View>
  );
}

mount(App);
