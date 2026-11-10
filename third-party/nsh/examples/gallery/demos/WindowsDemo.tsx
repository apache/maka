// The Windows demo (desktops): a small writing app whose workspace is the
// gallery's window. The document opens in a frameless window of its own, an
// inspector floats beside it, preferences open as a dialog sized to their
// rows and a command palette pops up over everything. One engine renders
// every window, so they all read and write the same signals: the inspector
// edits the document's title and the document window shows it at once.
import { cleanup, effect, type JSX, keymap, LayoutAnimation, type LayoutAnimationConfig, platform, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton, Command, type CommandItem, Input, Toolbar } from "nsh/base";
import { currentWindow, isAvailable, Window, type WindowMode, type WindowRef, type WindowState, windows } from "nsh/desktop";
import {
  alpha,
  Appear,
  Badge,
  Button,
  Caption,
  Card,
  colors,
  CommandEmpty,
  CommandHeading,
  CommandRow,
  commandClasses,
  DemoPage,
  focusRing,
  hovered,
  Icon,
  type IconName,
  iconButtonGlyph,
  iconButtonLook,
  IconTile,
  Meter,
  mono,
  PopIn,
  Row,
  Segmented,
  Stat,
  Status,
  terminal,
  tints,
  Tip,
  Toggle,
  toggleGlyph,
  toggleLook,
  type Tone,
  toolbarTrack,
  windowControls,
} from "../ui";
import { toast } from "../toast";
import { Field } from "./OverlayUi";

/** Windows of the app's own: macOS, Windows and Linux (a terminal program
 * has its terminal's). */
const supported = isAvailable && !terminal;
const mac = platform.os === "macos";
const pointer = platform.desktop;
/** The page's sizes: a pointer's compact tier, a touch screen's roomier one. */
const size = pointer ? { body: 13, note: 12, row: 48, tile: 30 } : { body: 15, note: 13, row: 60, tile: 36 };

// --- The document every window shares --------------------------------------------------------

type TextSize = "s" | "m" | "l";
const FONT: Record<TextSize, number> = { s: 14, m: 16, l: 19 };

/** A block of the document: a paragraph, a section's heading or an item
 * of a list, each edited in an input of its own and set as its kind is. */
type BlockKind = "paragraph" | "heading" | "item";
const block = (kind: BlockKind, text: string) => ({ kind, text: signal(text) });
type Block = ReturnType<typeof block>;

const doc = {
  title: signal("Release notes 2.4"),
  blocks: [
    block("paragraph", "Version 2.4 gives every desktop app windows of its own."),
    block("paragraph", "Open a document beside the workspace, keep the inspector floating over it, and reach any command from the palette without leaving the keyboard."),
    block("heading", "What's new"),
    block("item", "Windows open where you left them"),
    block("item", "The inspector follows the document you are editing"),
    block("item", "Exports show their progress on the Dock and the taskbar"),
    block("heading", "Fixes"),
    block("item", "Leaving full screen restores the window's size"),
    block("item", "Dialogs open centered on the window that asked for them"),
  ] as Block[],
  saved: signal(""),
  size: signal<TextSize>("m"),
  mono: signal(false),
  /** The export's share done while it runs. */
  exporting: signal<number | null>(null),
};
/** The document's text, a block a line. */
const body = () => doc.blocks.map((b) => b.text()).join("\n");
doc.saved.set(body());
const edited = () => body() !== doc.saved();
const words = () => (body().match(/\S+/g) ?? []).length;
const minutes = () => Math.max(1, Math.round(words() / 200));
/** The opening paragraphs, run together, for the workspace's preview. */
const excerpt = () =>
  doc.blocks
    .filter((b) => b.kind === "paragraph")
    .slice(0, 2)
    .map((b) => b.text())
    .join(" ");

/** What the preferences choose, which the other windows follow. */
const prefs = {
  autosave: signal(false),
  inspectorOnTop: signal(true),
  translucent: signal(true),
};

/** The inspector: a `<Window>` this signal controls. */
const inspectorOpen = signal(false);

function save() {
  if (!edited()) return;
  doc.saved.set(body());
}

function exportDocument() {
  if (doc.exporting() != null) return;
  doc.exporting.set(0);
  const timer = setInterval(() => {
    const next = (doc.exporting() ?? 0) + 0.04;
    if (next < 1) {
      doc.exporting.set(next);
      return;
    }
    clearInterval(timer);
    doc.exporting.set(null);
    void toast({ title: "Exported", description: `${doc.title() || "Untitled"}.pdf`, kind: "success" });
  }, 60);
}

const toggleInspector = () => inspectorOpen.set(!inspectorOpen());

// `Window.open` returns the window already open under an id, so each
// opener also brings its window back to the front.
function openDocument() {
  Window.open(DocumentWindow, {
    id: "document",
    title: doc.title(),
    defaultSize: { width: 640, height: 560 },
    minSize: { width: 420, height: 360 },
    defaultPosition: "center",
    // The document draws its whole frame: title bar, window buttons and
    // the edges that resize it.
    frame: "none",
    restoreBounds: true,
  }).focus();
}

function openPreferences() {
  Window.open(PreferencesWindow, {
    id: "preferences",
    kind: "dialog",
    parent: "main",
    modal: true,
    title: "Preferences",
    defaultPosition: "parentCenter",
    // As tall as its rows, whatever the platform's fonts.
    sizeToContent: true,
  }).focus();
}

function openPalette() {
  Window.open(PaletteWindow, {
    id: "palette",
    kind: "popup",
    defaultSize: { width: 560, height: 380 },
    defaultPosition: "center",
    // The palette's own rounded card is its whole shape.
    transparent: true,
  }).focus();
}

// --- The workspace (the gallery's window) ------------------------------------------------------

/** A tool of the workspace's toolbar: an icon, its name as a tooltip and
 * for screen readers, its shortcut. */
function Tool(props: { icon: IconName; label: string; shortcut?: string; on?: boolean; onPress: () => void }) {
  return (
    <BaseButton
      accessibilityLabel={props.label}
      selected={props.on}
      tooltip={<Tip label={props.label} shortcut={props.shortcut} />}
      onPress={props.onPress}
      {...toggleLook({ on: () => !!props.on })}
    >
      <Icon name={props.icon} {...toggleGlyph(() => !!props.on)} />
    </BaseButton>
  );
}

/** The draft in the workspace: its title, length and opening, and what
 * opens beside it. */
function Draft() {
  return (
    <Card
      icon="document"
      title="Draft"
      subtitle="Written in a window of its own"
      right={<Badge label={edited() ? "Edited" : "Saved"} tone={edited() ? "warn" : "neutral"} />}
    >
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{doc.title() || "Untitled"}</Text>
        <Text style={{ fontSize: size.note, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${words()} words · ${minutes()} min read`}</Text>
      </View>
      <Text style={{ fontSize: size.body, lineHeight: Math.round(size.body * 1.5), color: colors.muted, numberOfLines: 3 }}>{excerpt()}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button label="Open document" icon="document" onPress={openDocument} />
        <View style={{ flex: 1 }} />
        <Toolbar accessibilityLabel="Window tools" style={toolbarTrack()}>
          <Tool icon="sidebar" label="Inspector" shortcut="mod+alt+i" on={inspectorOpen()} onPress={toggleInspector} />
          <Tool icon="controls" label="Preferences" shortcut="mod+," onPress={openPreferences} />
          <Tool icon="search" label="Commands" shortcut="mod+shift+p" onPress={openPalette} />
        </Toolbar>
      </View>
      {/* Shown while the tool is on; closing the panel turns it off. It
          closes with this page, too. */}
      <Window
        id="inspector"
        kind="panel"
        title="Inspector"
        parent="main"
        open={inspectorOpen()}
        onOpenChange={({ open }) => inspectorOpen.set(open)}
        defaultSize={{ width: 300, height: 440 }}
        // As tall as its groups; the width stays the reader's.
        sizeToContent="height"
        minSize={{ width: 260, height: 200 }}
        level={prefs.inspectorOnTop() ? "floating" : "normal"}
        backdrop={prefs.translucent() ? "sidebar" : "none"}
      >
        <Inspector />
      </Window>
    </Card>
  );
}

/** What each window is: its icon, its name and what kind of window it is. */
const INFO: Record<string, { icon: IconName; title: () => string; kind: string }> = {
  main: { icon: "dock", title: () => "Gallery", kind: "Workspace" },
  inspector: { icon: "sidebar", title: () => "Inspector", kind: "Floating panel" },
  document: { icon: "document", title: () => doc.title() || "Untitled", kind: "Document" },
  preferences: { icon: "controls", title: () => "Preferences", kind: "Dialog" },
  palette: { icon: "search", title: () => "Commands", kind: "Command palette" },
};

/** A window's state in a word. */
function stateOf(s: WindowState | null): { label: string; tone: Tone } {
  if (!s) return { label: "Opening", tone: "neutral" };
  if (s.minimized) return { label: "Minimized", tone: "neutral" };
  if (s.focused) return { label: "Active", tone: "accent" };
  if (s.mode === "fullScreen") return { label: "Full screen", tone: "neutral" };
  if (s.mode === "maximized") return { label: "Maximized", tone: "neutral" };
  return { label: s.visible ? "Open" : "Hidden", tone: "neutral" };
}

/** One of the app's windows: pressed, it comes to the front; its close
 * button (none on the workspace) closes it. */
function WindowRow(props: { win: WindowRef; first: boolean }) {
  const info = () => INFO[props.win.id] ?? { icon: "layers" as IconName, title: () => props.win.id, kind: "Window" };
  const state = () => stateOf(props.win.state());
  return (
    <Appear>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: props.first ? 0 : 1, borderTopColor: colors.line }}>
        <BaseButton
          testID={`window-${props.win.id}`}
          accessibilityLabel={`${info().title()}, ${state().label}`}
          onPress={() => props.win.focus()}
          style={{
            flex: 1,
            minHeight: size.row,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingHorizontal: 8,
            marginLeft: -8,
            borderRadius: 8,
            transitionProperty: "background-color",
            transitionDuration: 120,
          }}
          hoverStyle={hovered()}
          activeStyle={{ backgroundColor: alpha(colors.text, 0.08) }}
          focusStyle={focusRing()}
        >
          <IconTile name={info().icon} size={size.tile} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ fontSize: size.body, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{info().title()}</Text>
            <Text style={{ fontSize: size.note, color: colors.muted, numberOfLines: 1 }}>{info().kind}</Text>
          </View>
          <Status label={state().label} tone={state().tone} />
        </BaseButton>
        {/* A lane of its own, so every row's chip keeps one column. */}
        <View style={{ width: pointer ? 28 : 40, alignItems: "center" }}>
          <If when={!props.win.main}>
            <BaseButton
              accessibilityLabel={`Close ${info().title()}`}
              tooltip={<Tip label="Close" />}
              onPress={() => props.win.close()}
              {...iconButtonLook()}
            >
              <Icon name="close" {...iconButtonGlyph()} />
            </BaseButton>
          </If>
        </View>
      </View>
    </Appear>
  );
}

/** A window's row leaving: it fades while the rows under it close up. */
const ROW_EXIT: LayoutAnimationConfig = {
  duration: 220,
  update: { type: "easeInEaseOut" },
  delete: { type: "easeInEaseOut", property: "opacity", duration: 160 },
};

function OpenWindows() {
  // Rows come in with `Appear`; a window that closes (from its row, its own
  // close button or the system) leaves through the commit that removes its
  // row, which this layout animation covers.
  let shown = untracked(windows).map((w) => w.id);
  effect(() => {
    const ids = windows().map((w) => w.id);
    if (shown.some((id) => !ids.includes(id)) && !reduceMotion()) LayoutAnimation.configureNext(ROW_EXIT);
    shown = ids;
  });
  return (
    <Card
      icon="layers"
      title="Open windows"
      subtitle={`${pointer ? "Click" : "Tap"} one to bring it to the front`}
      right={<Badge label={`${windows().length} open`} />}
    >
      <View>
        <Each of={windows()}>{(win, i) => <WindowRow win={win()} first={i() === 0} />}</Each>
      </View>
    </Card>
  );
}

const MODES: readonly { value: WindowMode; label: string }[] = [
  { value: "normal", label: "Window" },
  { value: "maximized", label: "Maximized" },
  { value: "fullScreen", label: "Full screen" },
];

const extent = (s: WindowState | null) => (s ? `${Math.round(s.bounds.size.width)} × ${Math.round(s.bounds.size.height)}` : "—");

/** The gallery's own window: where it is and how it shows. */
function ThisWindow() {
  const win = currentWindow();
  const state = () => win.state();
  const active = () => state()?.focused !== false;
  // Timers the buttons start, stopped if the page goes first.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  cleanup(() => timers.forEach(clearTimeout));
  const later = (ms: number, f: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      f();
    }, ms);
    timers.add(timer);
  };
  const attention = mac ? "Bounce in the Dock" : "Flash the taskbar";
  return (
    <Card
      icon="system"
      title="This window"
      subtitle="Where the gallery's window is"
      right={<Status label={active() ? "Active" : "In the background"} tone={active() ? "accent" : undefined} />}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Stat label="Size" value={extent(state())} width="50%" />
        <Stat label="Position" value={state() ? `${Math.round(state()!.bounds.origin.x)}, ${Math.round(state()!.bounds.origin.y)}` : "—"} width="50%" />
        <Stat label="Display" value={state()?.display?.name || "—"} width="50%" truncate />
        <Stat label="Scale" value={state() ? `${state()!.scaleFactor}×` : "—"} width="50%" />
      </View>
      <Segmented
        options={MODES}
        value={state()?.mode ?? "normal"}
        onChange={(mode) => win.setMode(mode)}
        fill
      />
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            label="Resize"
            variant="secondary"
            flex={1}
            onPress={() => {
              win.setBounds({ size: { width: 1000, height: 720 }, animated: true });
            }}
          />
          <Button
            label="Center"
            variant="secondary"
            flex={1}
            onPress={() => win.center()}
          />
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            label="Minimize"
            variant="secondary"
            flex={1}
            onPress={() => {
              win.minimize();
              later(2000, () => win.restore());
            }}
          />
          <Button
            label={attention}
            variant="secondary"
            flex={1}
            onPress={() => {
              // It shows only while another app is in front.
              void toast({ title: "Switch to another app", description: mac ? "The Dock icon bounces in 3 seconds" : "The taskbar button flashes in 3 seconds", kind: "info" });
              later(3000, () => win.requestAttention());
            }}
          />
        </View>
      </View>
    </Card>
  );
}

/** Off the desktops: what the demo is, and where it runs. */
function Elsewhere() {
  return (
    <Card icon="system" title="Desktop windows" subtitle="macOS, Windows and Linux">
      <Caption label="On a desktop, the document, its inspector, the preferences and a command palette open in windows of their own." />
    </Card>
  );
}

export function WindowsDemo() {
  if (!supported) return <DemoPage cards={[Elsewhere]} />;
  // The app's shortcuts, bound while the demo shows.
  keymap.bind({
    "mod+shift+p": () => openPalette(),
    "mod+,": () => openPreferences(),
    "mod+alt+i": () => toggleInspector(),
  });
  return <DemoPage cards={[Draft, OpenWindows, ThisWindow]} />;
}

// --- The inspector -------------------------------------------------------------------------------

/** A group of the inspector, under its heading. */
function Group(props: { title: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 12 }} role="group" accessibilityLabel={props.title}>
      <Text role="header" style={{ fontSize: 12, fontWeight: "600", color: colors.muted }}>
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

/** A label over its control. */
function Labeled(props: { label: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: size.note, color: colors.muted }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function Inspector() {
  // The material shows through where the platform has one (macOS and
  // Windows 11); elsewhere the sidebar's color.
  const translucent = () => prefs.translucent() && platform.os !== "linux";
  return (
    <View style={{ padding: 16, gap: 24, backgroundColor: translucent() ? "transparent" : colors.sidebar }}>
      <Group title="Document">
        <Labeled label="Title">
          <Field value={doc.title()} onChange={({ value }) => doc.title.set(value)} accessibilityLabel="Title" placeholder="Untitled" />
        </Labeled>
        <Labeled label="Text size">
          <Segmented
            options={[
              { value: "s", label: "Small" },
              { value: "m", label: "Medium" },
              { value: "l", label: "Large" },
            ]}
            value={doc.size()}
            onChange={(v) => doc.size.set(v)}
            size="small"
            fill
          />
        </Labeled>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}>
          <Text style={{ flex: 1, fontSize: size.body, color: colors.text }}>Monospace</Text>
          <Toggle value={doc.mono()} onChange={(v) => doc.mono.set(v)} label="Monospace" />
        </View>
      </Group>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <Group title="Statistics">
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Stat label="Words" value={String(words())} width="50%" />
          <Stat label="Characters" value={String(body().length)} width="50%" />
          <Stat label="Reading time" value={`${minutes()} min`} width="50%" />
          <Stat label="Status" value={edited() ? "Edited" : "Saved"} tone={edited() ? "warn" : undefined} width="50%" />
        </View>
      </Group>
      <Button label="Open document" icon="document" variant="secondary" onPress={openDocument} />
    </View>
  );
}

// --- The preferences dialog --------------------------------------------------------------------

function Preference(props: { first?: boolean; title: string; detail: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row first={props.first}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: size.body, color: colors.text }}>{props.title}</Text>
        <Text style={{ fontSize: size.note, color: colors.muted }}>{props.detail}</Text>
      </View>
      <Toggle value={props.value} onChange={props.onChange} label={props.title} />
    </Row>
  );
}

function PreferencesWindow() {
  const win = currentWindow();
  return (
    // The window takes this width and the rows' height (`sizeToContent`).
    <View style={{ width: 420, padding: 20, gap: 16, backgroundColor: colors.background }}>
      <View
        style={{
          paddingHorizontal: 14,
          borderRadius: 10,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        }}
      >
        <Preference
          first
          title="Autosave"
          detail="Saves a moment after you stop typing"
          value={prefs.autosave()}
          onChange={(v) => prefs.autosave.set(v)}
        />
        <Preference
          title="Keep the inspector on top"
          detail="It stays above the document while you write"
          value={prefs.inspectorOnTop()}
          onChange={(v) => prefs.inspectorOnTop.set(v)}
        />
        <Preference
          title="Translucent inspector"
          detail="Lets the desktop show through its background"
          value={prefs.translucent()}
          onChange={(v) => prefs.translucent.set(v)}
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button label="Done" onPress={() => win.close()} />
      </View>
    </View>
  );
}

// --- The command palette -----------------------------------------------------------------------

interface Action {
  item: CommandItem;
  icon: IconName;
  run: () => void;
}

const actions = (): Action[] => [
  { item: { id: "open", label: "Open Document", group: "Document", keywords: ["window"] }, icon: "document", run: openDocument },
  { item: { id: "save", label: "Save", group: "Document", disabled: !edited() }, icon: "check", run: save },
  { item: { id: "export", label: "Export as PDF", group: "Document", disabled: doc.exporting() != null }, icon: "download", run: exportDocument },
  {
    item: { id: "inspector", label: inspectorOpen() ? "Hide Inspector" : "Show Inspector", group: "Windows", shortcut: "mod+alt+i", keywords: ["panel"] },
    icon: "sidebar",
    run: toggleInspector,
  },
  { item: { id: "preferences", label: "Preferences…", group: "Windows", shortcut: "mod+,", keywords: ["settings"] }, icon: "controls", run: openPreferences },
  {
    item: { id: "center", label: "Center the Gallery", group: "Windows", keywords: ["window", "middle"] },
    icon: "dock",
    run: () => Window.get("main")?.center(),
  },
];

function PaletteWindow() {
  const win = currentWindow();
  const query = signal("");
  const run = (id: string) => {
    const action = actions().find((a) => a.item.id === id);
    if (!action) return;
    win.close();
    action.run();
  };
  return (
    <PopIn side="top" style={{ flex: 1 }}>
      <Command
        items={actions().map((a) => a.item)}
        query={query()}
        onQueryChange={({ query: next }) => query.set(next)}
        // Escape with an empty query; a click elsewhere closes the window too.
        onCancel={() => win.close()}
        onSelect={({ id }) => run(id)}
        autoFocus
        placeholder="Search commands…"
        accessibilityLabel="Commands"
        searchAccessibilityLabel="Search commands"
        class={`${commandClasses.root} flex-1`}
        searchBarClass={commandClasses.searchBar}
        searchClass={commandClasses.search}
        listClass={`${commandClasses.list} flex-1`}
        groupClass={commandClasses.group}
        separatorClass={commandClasses.separator}
        itemClass={commandClasses.item}
        searchPrefix={<Icon name="search" size={16} tint={colors.muted} />}
        empty={<CommandEmpty label="No commands match" />}
        renderGroup={(group) => <CommandHeading group={group} />}
        renderItem={(entry) => <CommandRow entry={entry} icon={actions().find((a) => a.item.id === entry.id)?.icon} />}
        footer={
          <View class="flex-row gap-4 border-t border-border px-3" style={{ height: 32, alignItems: "center" }}>
            <Text style={{ fontSize: 11, color: colors.faint }}>↑↓ to move</Text>
            <Text style={{ fontSize: 11, color: colors.faint }}>↩ to run</Text>
            <Text style={{ fontSize: 11, color: colors.faint }}>esc to close</Text>
          </View>
        }
      />
    </PopIn>
  );
}

// --- The document window -------------------------------------------------------------------------

type Control = "close" | "minimize" | "maximize";

/** macOS's three window buttons, drawn by the app at the leading edge: each
 * acts as the system's (`windowControl`), their glyphs show while the
 * pointer is over the group, and they turn grey while the window is in the
 * background. */
function TrafficLights(props: { active: boolean }) {
  const over = signal(false);
  const light = (control: Control, label: string, tone: string, glyph: JSX.Element) => (
    <View
      desktop={{ windowControl: control }}
      role="button"
      accessibilityLabel={label}
      style={{
        width: 12,
        height: 12,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.active || over() ? tone : windowControls.off,
        borderWidth: 0.5,
        borderColor: windowControls.edge,
        transitionProperty: "colors",
        transitionDuration: 120,
      }}
    >
      <View style={{ opacity: over() ? 1 : 0, transitionProperty: "opacity", transitionDuration: 120 }}>{glyph}</View>
    </View>
  );
  const ink = windowControls.ink;
  return (
    <View
      onMouseEnter={() => over.set(true)}
      onMouseLeave={() => over.set(false)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      {light("close", "Close", windowControls.close, <Icon name="close" size={8} tint={ink} weight={2} />)}
      {light("minimize", "Minimize", windowControls.minimize, <View style={{ width: 6, height: 1.5, borderRadius: 1, backgroundColor: ink }} />)}
      {light("maximize", "Zoom", windowControls.zoom, <Icon name="plus" size={8} tint={ink} weight={2} />)}
    </View>
  );
}

/** The window buttons of Windows and Linux, drawn by the app at the
 * trailing edge, as tall as the title bar: each acts as the system's
 * (`windowControl`: Windows 11 shows its snap layouts over the maximize
 * button), the close button tinted in the danger tone under the pointer. */
function CaptionButtons() {
  const button = (control: Control, label: string, glyph: JSX.Element) => (
    <View
      desktop={{ windowControl: control }}
      role="button"
      accessibilityLabel={label}
      style={{ width: 46, alignSelf: "stretch", alignItems: "center", justifyContent: "center", transitionProperty: "background-color", transitionDuration: 120 }}
      hoverStyle={{ backgroundColor: control === "close" ? tints.danger : alpha(colors.text, 0.06) }}
    >
      {glyph}
    </View>
  );
  return (
    <View style={{ flexDirection: "row", alignSelf: "stretch" }}>
      {button("minimize", "Minimize", <View style={{ width: 10, height: 1, backgroundColor: colors.text }} />)}
      {button("maximize", "Maximize", <View style={{ width: 10, height: 10, borderRadius: 1.5, borderWidth: 1, borderColor: colors.text }} />)}
      {button("close", "Close", <Icon name="close" size={12} tint={colors.text} weight={1.25} />)}
    </View>
  );
}

/** A frameless window's edges and corners, which resize it
 * (`windowResize`): thin strips over the content's border. */
function ResizeEdges() {
  const edge = 5;
  const corner = 12;
  const at = (style: Record<string, number>) => ({ position: "absolute" as const, ...style });
  return (
    <>
      <View desktop={{ windowResize: "top" }} style={at({ top: 0, left: corner, right: corner, height: edge })} />
      <View desktop={{ windowResize: "bottom" }} style={at({ bottom: 0, left: corner, right: corner, height: edge })} />
      <View desktop={{ windowResize: "left" }} style={at({ left: 0, top: corner, bottom: corner, width: edge })} />
      <View desktop={{ windowResize: "right" }} style={at({ right: 0, top: corner, bottom: corner, width: edge })} />
      <View desktop={{ windowResize: "topLeft" }} style={at({ top: 0, left: 0, width: corner, height: corner })} />
      <View desktop={{ windowResize: "topRight" }} style={at({ top: 0, right: 0, width: corner, height: corner })} />
      <View desktop={{ windowResize: "bottomLeft" }} style={at({ bottom: 0, left: 0, width: corner, height: corner })} />
      <View desktop={{ windowResize: "bottomRight" }} style={at({ bottom: 0, right: 0, width: corner, height: corner })} />
    </>
  );
}

/** One block of the document, set as a writing app sets it: paragraphs in
 * the reading size with room between them, headings larger and heavier with
 * more room above than below, items after a bullet. Paragraphs and items
 * grow with their text. */
function BlockInput(props: { block: Block; first: boolean }) {
  const font = () => FONT[doc.size()];
  const lineHeight = () => Math.round(font() * 1.6);
  // The text's height, as the input reports it.
  const height = signal(0);
  const text = () => ({
    fontSize: font(),
    lineHeight: lineHeight(),
    fontFamily: doc.mono() ? mono : undefined,
    color: colors.text,
    selectionColor: colors.accent,
    caretColor: colors.accent,
  });
  const grown = () => Math.max(lineHeight(), height());
  if (props.block.kind === "heading") {
    const heading = () => Math.round(font() * 1.3);
    return (
      <Input
        value={props.block.text()}
        onChange={({ value }) => props.block.text.set(value)}
        accessibilityLabel="Heading"
        style={{
          ...text(),
          fontSize: heading(),
          lineHeight: Math.round(heading() * 1.3),
          fontWeight: "600",
          letterSpacing: -0.2,
          marginTop: props.first ? 0 : Math.round(font() * 1.25),
          marginBottom: Math.round(font() * 0.5),
        }}
      />
    );
  }
  const input = (
    <Input
      multiline
      value={props.block.text()}
      onChange={({ value }) => props.block.text.set(value)}
      onContentSizeChange={({ size }) => height.set(size.height)}
      accessibilityLabel={props.block.kind === "item" ? "List item" : "Paragraph"}
      style={{ ...text(), flex: props.block.kind === "item" ? 1 : undefined, height: grown() }}
    />
  );
  if (props.block.kind === "paragraph") return <View style={{ marginBottom: Math.round(font() * 0.75) }}>{input}</View>;
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingLeft: 2, marginBottom: Math.round(font() * 0.3) }}>
      {/* The bullet, centered on the item's first line. */}
      <View style={{ width: 5, height: 5, borderRadius: 2.5, marginTop: (lineHeight() - 5) / 2, backgroundColor: colors.muted }} />
      {input}
    </View>
  );
}

const TODAY = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

function DocumentWindow() {
  const win = currentWindow();
  const active = () => win.state()?.focused ?? true;
  // The window's title, the unsaved dot (macOS) and the export's progress
  // on the Dock or the taskbar follow the document.
  effect(() => {
    const share = doc.exporting();
    win.set({ title: doc.title() || "Untitled", edited: edited(), progress: share == null ? null : { value: share } });
  });
  // Autosave: a moment after the last edit.
  effect(() => {
    if (!prefs.autosave() || !edited()) return;
    const timer = setTimeout(save, 800);
    cleanup(() => clearTimeout(timer));
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
      {/* The title bar: dragging it moves the window, a double click zooms
          or maximizes it; its buttons stay buttons. */}
      <View
        desktop={{ windowDrag: true }}
        style={{
          height: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 14,
          paddingRight: mac ? 10 : 0,
          backgroundColor: colors.inset,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
        }}
      >
        <If when={mac}>
          <View style={{ marginRight: 8 }}>
            <TrafficLights active={active()} />
          </View>
        </If>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, opacity: active() ? 1 : 0.55 }}>
          <Icon name="document" size={14} tint={colors.muted} />
          <Text style={{ flexShrink: 1, fontSize: 13, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{doc.title() || "Untitled"}</Text>
          <If when={edited()}>
            <Text style={{ fontSize: 12, color: colors.faint }}>Edited</Text>
          </If>
        </View>
        <Button label="Save" size="small" variant="ghost" disabled={!edited()} onPress={save} />
        <Button label="Export" icon="download" size="small" variant="secondary" busy={doc.exporting() != null} onPress={exportDocument} />
        <BaseButton
          accessibilityLabel="Inspector"
          selected={inspectorOpen()}
          tooltip={<Tip label="Inspector" shortcut="mod+alt+i" />}
          onPress={toggleInspector}
          {...toggleLook({ on: () => inspectorOpen(), size: "small" })}
        >
          <Icon name="sidebar" {...toggleGlyph(() => inspectorOpen(), { size: "small" })} />
        </BaseButton>
        <If when={!mac}>
          <View style={{ width: 4 }} />
          <CaptionButtons />
        </If>
      </View>
      {/* The page: a reading column, its title over the blocks. */}
      <Scroll style={{ flex: 1 }}>
        <View style={{ alignItems: "center", paddingHorizontal: 32, paddingTop: 28, paddingBottom: 40 }}>
          <View style={{ width: "100%", maxWidth: 640 }}>
            <Input
              value={doc.title()}
              onChange={({ value }) => doc.title.set(value)}
              placeholder="Untitled"
              accessibilityLabel="Title"
              style={{ fontSize: 26, fontWeight: "700", letterSpacing: -0.4, color: colors.text, placeholderColor: colors.faint, caretColor: colors.accent, selectionColor: colors.accent }}
            />
            <Text style={{ marginTop: 6, marginBottom: 20, fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${TODAY} · ${minutes()} min read`}</Text>
            <Each of={doc.blocks}>{(b, i) => <BlockInput block={b()} first={i() === 0} />}</Each>
          </View>
        </View>
      </Scroll>
      <View
        style={{
          height: 28,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 14,
          borderTopWidth: 1,
          borderTopColor: colors.line,
          backgroundColor: colors.inset,
        }}
      >
        <Text style={{ fontSize: 11, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${words()} words`}</Text>
        <Text style={{ fontSize: 11, color: colors.faint }}>{edited() ? "Not saved" : prefs.autosave() ? "Saved automatically" : "Saved"}</Text>
        <View style={{ flex: 1 }} />
        <If when={doc.exporting() != null}>
          <Text style={{ fontSize: 11, color: colors.muted }}>Exporting</Text>
          <View style={{ width: 96 }}>
            <Meter value={doc.exporting() ?? 0} />
          </View>
          <Text style={{ width: 30, fontSize: 11, color: colors.muted, fontVariant: ["tabular-nums"], textAlign: "right" }}>
            {`${Math.round((doc.exporting() ?? 0) * 100)}%`}
          </Text>
        </If>
      </View>
      <ResizeEdges />
    </View>
  );
}
