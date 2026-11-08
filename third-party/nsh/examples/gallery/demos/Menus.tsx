import { type JSX, LayoutAnimation, reduceMotion, Scroll, setColorScheme, signal, Text, token, View } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator, type OpenChangeReason, Submenu, Toolbar } from "nsh/base";
import { platform } from "nsh";
import { keymap } from "nsh";
import { Icon, LucideIcon, type LucideIconName } from "../icons";
import { toast, updateToast } from "../toast";
import { alpha, backdrop, Badge, Button, Caption, Card, colors, DemoPage, finish, isDark, menuHighlight, menuIndicator, menuItemGlyph, menuItemLabel, menuItemLook, menuItemNote, menuItemSize, MenuLabel, MenuMark, MenuPanel, menuPressed, menuSeparator, menuSheet, mono, Row, Segmented, SubmenuBack, SubmenuRow, terminal, Tip } from "../ui";

// The look of every menu here is the gallery's (`look/menu.tsx`):
// `nsh/base` draws none.

const pointer = platform.desktop;

/**
 * One row of a menu: an icon, the label, a note (a shortcut, a value). A
 * checkable row (`checked`) shows its mark where the icon goes, as
 * gpui-component's menus put their check: a check for a setting, a dot for
 * one choice of a group (`radio`), fading in as the app checks it.
 */
function Item(props: {
  label: string;
  icon?: LucideIconName;
  onSelect?: () => void;
  shortcut?: string;
  note?: string;
  checked?: boolean;
  radio?: boolean;
  disabled?: boolean;
  danger?: boolean;
  keepOpen?: boolean;
}) {
  return (
    <MenuItem
      onSelect={props.onSelect}
      disabled={props.disabled}
      checked={props.checked}
      role={props.radio ? "menuitemradio" : undefined}
      closeOnSelect={!props.keepOpen}
      indicatorClass={menuIndicator}
      indicator={props.checked === undefined ? undefined : <MenuMark kind={props.radio ? "dot" : "check"} size={menuItemSize.icon} tint={colors.accent} />}
      {...menuItemLook()}
    >
      <If when={props.icon && props.checked === undefined}>
        <LucideIcon name={props.icon!} {...menuItemGlyph({ danger: props.danger })} />
      </If>
      <Text style={menuItemLabel({ danger: props.danger })}>{props.label}</Text>
      <If when={props.shortcut ?? props.note}>
        <Text style={menuItemNote()}>{props.shortcut ?? props.note}</Text>
      </If>
    </MenuItem>
  );
}

/** The row that opens a submenu, and the row a sheet shows to come back. */
function SubmenuOf(props: { label: string; icon?: LucideIconName; children: JSX.Element; disabled?: boolean }) {
  return (
    <Submenu
      offset={4}
      disabled={props.disabled}
      trigger={<SubmenuRow label={props.label} disabled={props.disabled} lead={props.icon ? <LucideIcon name={props.icon} {...menuItemGlyph()} /> : undefined} />}
      back={<SubmenuBack label={props.label} />}
    >
      <MenuPanel side="right">{props.children}</MenuPanel>
    </Submenu>
  );
}

function Separator() {
  return <MenuSeparator style={menuSeparator()} />;
}

/** What opens a menu: a quiet menu bar title (`bar`), else a raised button. */
function Chip(props: { label: string; icon?: "plus" | "search" | "star"; bar?: boolean; open?: boolean }) {
  // Open: selected, as the shared `Button`'s `selected` (a menu bar title
  // keeps the hover's accent fill, a raised button its pressed look).
  const look = () =>
    props.bar
      ? { borderColor: "transparent", backgroundColor: props.open ? token("accent") : "transparent" }
      : { backgroundColor: colors.raised, ...(props.open ? finish.pressed : finish.raised) };
  return (
    <View
      hoverStyle={props.open ? undefined : props.bar ? { backgroundColor: alpha(colors.text, 0.06) } : finish.hover}
      activeStyle={props.bar ? { backgroundColor: alpha(colors.text, 0.1) } : finish.pressed}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        alignSelf: "flex-start",
        height: pointer ? 28 : 36,
        paddingHorizontal: props.bar ? 10 : pointer ? 10 : 14,
        borderRadius: pointer ? 7 : 10,
        borderWidth: 1,
        ...look(),
        transitionProperty: "background-color, border-color, box-shadow",
        transitionDuration: 120,
      }}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} size={pointer ? 13 : 14} tint={colors.muted} />
      </If>
      <Text style={{ fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.text }}>{props.label}</Text>
    </View>
  );
}

const ZONES = [
  "UTC−10 Honolulu", "UTC−8 Los Angeles", "UTC−7 Denver", "UTC−6 Chicago", "UTC−5 New York", "UTC−3 São Paulo",
  "UTC±0 London", "UTC+1 Berlin", "UTC+2 Cairo", "UTC+3 Moscow", "UTC+4 Dubai", "UTC+5:30 Mumbai", "UTC+7 Bangkok",
  "UTC+8 Hong Kong", "UTC+8 Shanghai", "UTC+8 Singapore", "UTC+9 Tokyo", "UTC+9 Seoul", "UTC+10 Sydney", "UTC+12 Auckland",
];

type File = { id: number; name: string; starred: boolean };

type SortBy = "Name" | "Date modified" | "Size";
type Zoom = "Small" | "Medium" | "Large";
const SORTS: SortBy[] = ["Name", "Date modified", "Size"];
const ZOOMS: Zoom[] = ["Small", "Medium", "Large"];

/** The project the View menu's preview shows: when each file changed (days ago) and its size (KB). */
const PROJECT = [
  { name: "main.rs", days: 1, kb: 4.2 },
  { name: "Cargo.toml", days: 9, kb: 0.6 },
  { name: "README.md", days: 3, kb: 2.1 },
  { name: "lib.rs", days: 0, kb: 12.8 },
];
const sorted = (by: SortBy) =>
  [...PROJECT].sort((a, b) => (by === "Name" ? a.name.localeCompare(b.name) : by === "Date modified" ? a.days - b.days : b.kb - a.kb));

/** The code lines of the preview's editor, as fractions of its width. */
const LINES = [0.62, 0.38, 0.84, 0.7, 0.26, 0.55, 0.9, 0.44];

/**
 * A window the View menu arranges: its sidebar lists the files in the
 * chosen order, its editor's lines grow with the zoom, a minimap rides its
 * right edge. Each change is a layout animation, so panes slide and rows
 * move to their new places.
 */
function Preview(props: { sidebar: boolean; minimap: boolean; sort: SortBy; zoom: Zoom }) {
  const line = () => ({ Small: 4, Medium: 6, Large: 8 })[props.zoom];
  return (
    <View style={{ flexDirection: "row", height: 128, borderRadius: 10, borderWidth: 1, borderColor: colors.line, overflow: "hidden", backgroundColor: colors.surface }}>
      <View
        accessibilityLabel="Sidebar"
        style={{
          width: props.sidebar ? 104 : 0,
          opacity: props.sidebar ? 1 : 0,
          overflow: "hidden",
          backgroundColor: alpha(colors.text, 0.035),
          borderRightWidth: props.sidebar ? 1 : 0,
          borderColor: colors.line,
          paddingTop: 8,
          transitionProperty: "opacity",
          transitionDuration: 160,
        }}
      >
        <Each of={sorted(props.sort)} key={(f) => f.name}>
          {(f, i) => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, height: 22, paddingHorizontal: 8, backgroundColor: i() === 0 ? alpha(colors.accent, 0.12) : "transparent" }}>
              <LucideIcon name="file-text" size={11} tint={i() === 0 ? colors.accent : colors.faint} />
              <Text style={{ numberOfLines: 1, fontSize: 11, fontFamily: mono, color: i() === 0 ? colors.text : colors.muted }}>{f().name}</Text>
            </View>
          )}
        </Each>
      </View>
      <View style={{ flex: 1, padding: 10, gap: line() * 0.75 }}>
        <Each of={LINES}>
          {(w, i) => <View style={{ width: `${Math.round(w() * 100)}%`, height: line(), borderRadius: line() / 2, backgroundColor: i() % 3 === 0 ? alpha(colors.accent, 0.55) : alpha(colors.text, 0.16) }} />}
        </Each>
      </View>
      <View
        accessibilityLabel="Minimap"
        style={{ width: props.minimap ? 34 : 0, opacity: props.minimap ? 1 : 0, overflow: "hidden", borderLeftWidth: props.minimap ? 1 : 0, borderColor: colors.line, paddingVertical: 8, paddingHorizontal: 5, gap: 2, transitionProperty: "opacity", transitionDuration: 160 }}
      >
        <View style={{ position: "absolute", left: 2, right: 2, top: 6, height: 36, borderRadius: 3, backgroundColor: alpha(colors.text, 0.07) }} />
        <Each of={[...LINES, ...LINES]}>{(w) => <View style={{ width: `${Math.round(w() * 100)}%`, height: 2, borderRadius: 1, backgroundColor: alpha(colors.text, 0.22) }} />}</Each>
      </View>
    </View>
  );
}

/**
 * Menus of `nsh/base`, as complete as an app's: a menu bar whose menus have
 * shortcuts, submenus three levels deep, checkable settings and choices of
 * one that arrange a preview, group titles, disabled and destructive items; menus on the rows of a list
 * (the secondary button or a held finger, and a ⋯ button); where a popup
 * goes; a long menu that scrolls; a menu a shortcut opens. On desktops they
 * are popups with cascading submenus that grow out of their trigger, on
 * touch screens sheets that slide up, whose submenus take the place of
 * their items.
 */
export function Menus() {
  const events = signal<string[]>([]);
  const log = (what: string) => events.set([what, ...events()].slice(0, 6));
  // The menu shown: its trigger shows as selected while it is open.
  const shown = signal<string | null>(null);
  const isOpen = (menu: string) => shown() === menu;
  const changed = (menu: string) => ({ open, reason }: { open: boolean; reason: OpenChangeReason }) => {
    if (open) shown.set(menu);
    else if (shown() === menu) shown.set(null);
    log(`${menu} ${open ? "opened" : "closed"} · ${reason}`);
  };

  function MenuBar() {
    const history = signal<string[]>([]);
    const undone = signal<string[]>([]);
    const sidebar = signal(true);
    const minimap = signal(false);
    const sort = signal<SortBy>("Name");
    const zoom = signal<Zoom>("Medium");
    // A setting changes the preview's layout: its panes slide, its rows move.
    const arrange = (change: () => void) => {
      if (!reduceMotion()) LayoutAnimation.configureNext({ duration: 240, update: { type: "spring", springDamping: 0.85 } });
      change();
    };
    const recent = signal(["Budget.numbers", "Roadmap.md", "Trip photos"]);
    const act = (what: string) => {
      history.set([...history(), what]);
      undone.set([]);
      log(`chose ${what}`);
    };
    const undo = () => {
      const last = history().at(-1);
      if (!last) return;
      history.set(history().slice(0, -1));
      undone.set([...undone(), last]);
      log(`undid ${last}`);
    };
    const redo = () => {
      const last = undone().at(-1);
      if (!last) return;
      undone.set(undone().slice(0, -1));
      history.set([...history(), last]);
      log(`redid ${last}`);
    };
    // The shortcuts the items show work without the menu too.
    keymap.bind({
      "mod+alt+n": () => act("New document"),
      "mod+alt+s": () => act("Save"),
      "mod+alt+z": undo,
      "mod+alt+b": () => arrange(() => sidebar.set(!sidebar())),
      "mod+alt+shift+z": redo,
    });
    const key = (k: string) => (platform.desktop ? keymap.label(k) : undefined);
    return (
      <Card icon="lists" title="Menu bar" subtitle={platform.desktop ? "Hover across submenus; the shortcuts work too" : "Each menu a sheet; submenus take its place"}>
        {/* A toolbar: with one menu open, the pointer over another title opens it. */}
        <Toolbar accessibilityLabel="Menu bar" style={{ flexDirection: "row", gap: 2, marginLeft: pointer ? -10 : 0 }}>
          <Menu offset={4} margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed("File")} trigger={<Chip bar label="File" open={isOpen("File")} />}>
            <MenuPanel>
              <Item label="New document" icon="file-plus" shortcut={key("mod+alt+n")} onSelect={() => act("New document")} />
              <Item label="New window" icon="panel-top" onSelect={() => act("New window")} />
              <SubmenuOf label="Open recent" icon="clock">
                <Each of={recent()}>{(name) => <Item label={name()} onSelect={() => act(`Open ${name()}`)} />}</Each>
                <Separator />
                <Item label="Clear recent" disabled={recent().length === 0} onSelect={() => recent.set([])} />
              </SubmenuOf>
              <Separator />
              <Item label="Save" icon="download" shortcut={key("mod+alt+s")} onSelect={() => act("Save")} />
              <SubmenuOf label="Export as" icon="share-2">
                <Item label="PDF" onSelect={() => act("Export PDF")} />
                <SubmenuOf label="Image">
                  <Item label="PNG" onSelect={() => act("Export PNG")} />
                  <Item label="JPEG" onSelect={() => act("Export JPEG")} />
                  <Item label="WebP" onSelect={() => act("Export WebP")} />
                </SubmenuOf>
                <SubmenuOf label="Web page" disabled>
                  <Item label="HTML" />
                </SubmenuOf>
              </SubmenuOf>
              <Separator />
              <Item label="Delete document" icon="trash" danger onSelect={() => act("Delete document")} />
            </MenuPanel>
          </Menu>
          <Menu offset={4} margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed("Edit")} trigger={<Chip bar label="Edit" open={isOpen("Edit")} />}>
            <MenuPanel>
              <Item label={history().length ? `Undo ${history().at(-1)}` : "Undo"} icon="undo-2" shortcut={key("mod+alt+z")} disabled={history().length === 0} onSelect={undo} />
              <Item label={undone().length ? `Redo ${undone().at(-1)}` : "Redo"} icon="redo-2" shortcut={key("mod+alt+shift+z")} disabled={undone().length === 0} onSelect={redo} />
              <Separator />
              <MenuLabel text="Clipboard" />
              <Item label="Cut" icon="scissors" onSelect={() => act("Cut")} />
              <Item label="Copy" icon="copy" onSelect={() => act("Copy")} />
              <Item label="Paste" icon="clipboard-paste" onSelect={() => act("Paste")} />
            </MenuPanel>
          </Menu>
          <Menu offset={4} margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed("View")} trigger={<Chip bar label="View" open={isOpen("View")} />}>
            <MenuPanel>
              {/* Settings keep the menu open, so each shows its new value at once. */}
              <Item label="Show sidebar" checked={sidebar()} keepOpen shortcut={key("mod+alt+b")} onSelect={() => arrange(() => sidebar.set(!sidebar()))} />
              <Item label="Show minimap" checked={minimap()} keepOpen onSelect={() => arrange(() => minimap.set(!minimap()))} />
              <Separator />
              <MenuLabel text="Sort by" />
              {/* One choice of a group: choosing closes the menu. */}
              <Each of={SORTS}>{(by) => <Item label={by()} radio checked={sort() === by()} onSelect={() => arrange(() => sort.set(by()))} />}</Each>
              <Separator />
              <SubmenuOf label="Zoom" icon="maximize-2">
                <Each of={ZOOMS}>{(size) => <Item label={size()} radio checked={zoom() === size()} keepOpen onSelect={() => arrange(() => zoom.set(size()))} />}</Each>
              </SubmenuOf>
            </MenuPanel>
          </Menu>
        </Toolbar>
        <Preview sidebar={sidebar()} minimap={minimap()} sort={sort()} zoom={zoom()} />
        <Caption label={`Sidebar ${sidebar() ? "on" : "off"} · minimap ${minimap() ? "on" : "off"} · by ${sort()} · zoom ${zoom()}`} />
        <Caption label={history().length ? `Done: ${history().join(", ")}` : "Nothing done yet"} />
      </Card>
    );
  }

  function Rows() {
    let next = 5;
    const files = signal<File[]>([
      { id: 1, name: "Invoice March.pdf", starred: false },
      { id: 2, name: "Holiday.jpg", starred: true },
      { id: 3, name: "Notes.txt", starred: false },
      { id: 4, name: "Slides.key", starred: false },
    ]);
    const update = (id: number, change: (f: File) => File) => files.set(files().map((f) => (f.id === id ? change(f) : f)));
    const actions = (file: () => File) => (
      <MenuPanel>
        <Item label="Open" icon="external-link" onSelect={() => log(`open ${file().name}`)} />
        <Item label="Starred" checked={file().starred} onSelect={() => update(file().id, (f) => ({ ...f, starred: !f.starred }))} />
        <Item
          label="Duplicate"
          icon="copy"
          onSelect={() => {
            const f = file();
            const at = files().findIndex((x) => x.id === f.id);
            const copy = { id: next++, name: f.name.replace(/(\.[^.]+)?$/, " copy$1"), starred: false };
            files.set([...files().slice(0, at + 1), copy, ...files().slice(at + 1)]);
          }}
        />
        <SubmenuOf label="Move to" icon="folder-input">
          <Item label="Documents" onSelect={() => log(`moved ${file().name} to Documents`)} />
          <Item label="Archive" onSelect={() => log(`moved ${file().name} to Archive`)} />
        </SubmenuOf>
        <Separator />
        <Item label="Delete" icon="trash" danger onSelect={() => files.set(files().filter((f) => f.id !== file().id))} />
      </MenuPanel>
    );
    return (
      <Card icon="photos" title="On the rows of a list" subtitle={platform.desktop ? "Right click a row, or its ⋯ button" : "Hold a finger on a row, or press its ⋯"}>
        <If when={files().length > 0} else={<Caption label="No files left" />}>
          <View>
            <Each of={files()} key={(f) => f.id}>
              {(file, i) => (
                <ContextMenu margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed(file().name)} trigger={
                  <Row first={i() === 0} focusable>
                    <Icon name={file().starred ? "star" : "text"} size={16} tint={file().starred ? colors.accent : colors.muted} />
                    <Text style={{ numberOfLines: 1, flex: 1, fontSize: 14, color: colors.text }}>{file().name}</Text>
                    <Menu align="end" offset={4} margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed(`${file().name} ⋯`)} trigger={
                      <View
                        accessibilityLabel={`Actions for ${file().name}`}
                        tooltip={<Tip label="More actions" />}
                        hitSlop={8}
                        hoverStyle={menuHighlight()}
                        activeStyle={menuPressed()}
                        style={{
                          width: 28,
                          height: 28,
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 6,
                          backgroundColor: isOpen(`${file().name} ⋯`) ? token("accent") : "transparent",
                        }}
                      >
                        {/* The terminal draws no icons: the ellipsis as text, not a popup's ▾. */}
                        {terminal ? <Text style={{ color: colors.muted }}>⋯</Text> : <LucideIcon name="ellipsis" size={16} tint={colors.muted} />}
                      </View>
                    }>
                      {actions(file)}
                    </Menu>
                  </Row>
                }>
                  {actions(file)}
                </ContextMenu>
              )}
            </Each>
          </View>
        </If>
      </Card>
    );
  }

  function Placement() {
    const placement = signal<"top" | "bottom" | "left" | "right">("bottom");
    const align = signal<"start" | "center" | "end">("start");
    return (
      <Card icon="components" title="Where it goes" subtitle={platform.desktop ? "The side and alignment; it flips where there is no room" : "Phones show menus as sheets: try a desktop"}>
        <Segmented
          size="small"
          options={[{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }]}
          value={placement()}
          onChange={(v) => placement.set(v)}
        />
        <Segmented
          size="small"
          options={[{ value: "start", label: "Start" }, { value: "center", label: "Center" }, { value: "end", label: "End" }]}
          value={align()}
          onChange={(v) => align.set(v)}
        />
        <View style={{ alignItems: "center", paddingVertical: 24 }}>
          <Menu placement={placement()} align={align()} offset={6} margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed("Placed")} trigger={<Chip label={`${placement()} · ${align()}`} open={isOpen("Placed")} />}>
            <MenuPanel side={placement()}>
              <Item label="One" onSelect={() => log("chose One")} />
              <Item label="Two" onSelect={() => log("chose Two")} />
              <Item label="Three" onSelect={() => log("chose Three")} />
            </MenuPanel>
          </Menu>
        </View>
      </Card>
    );
  }

  function LongList() {
    const zone = signal("UTC+8 Hong Kong");
    return (
      <Card icon="scroll" title="A long menu" subtitle="Twenty choices in a menu that scrolls">
        <Menu offset={4} margin={8} popupStyle={menuSheet()} backdropStyle={backdrop()} onOpenChange={changed("Time zone")} trigger={<Chip label={zone()} icon="search" open={isOpen("Time zone")} />}>
          <MenuPanel flush>
            <Scroll style={{ maxHeight: platform.desktop ? 280 : 360 }} contentStyle={{ padding: 6 }}>
              <Each of={ZONES}>{(z) => <Item label={z()} radio checked={zone() === z()} onSelect={() => zone.set(z())} />}</Each>
            </Scroll>
          </MenuPanel>
        </Menu>
      </Card>
    );
  }

  function Commands() {
    const open = signal(false);
    // A command that takes a while: its toast spins, then says how it went.
    const sync = () => {
      log("ran Sync now");
      void toast({ id: "sync", kind: "loading", title: "Syncing…", duration: Infinity });
      setTimeout(() => updateToast("sync", { kind: "success", title: "Up to date", description: "4 files synced", duration: 3000 }), 1200);
    };
    keymap.bind("mod+shift+p", () => open.set(!open()));
    return (
      <Card icon="spark" title="Opened by the app" subtitle="A controlled menu: a button or a shortcut opens it" right={platform.desktop ? <Badge label={keymap.label("mod+shift+p")} /> : undefined}>
        <Menu
          open={open()}
          onOpenChange={({ open: next, reason }) => {
            open.set(next);
            log(`commands ${next ? "opened" : "closed"} · ${reason}`);
          }}
          offset={4}
          margin={8}
          popupStyle={menuSheet()}
          backdropStyle={backdrop()}
          trigger={<Chip label="Commands" icon="plus" open={open()} />}
        >
          <MenuPanel>
            <MenuLabel text="Commands" />
            <Item label="New note" icon="file-plus" onSelect={() => log("ran New note")} />
            <Item
              label={isDark() ? "Light appearance" : "Dark appearance"}
              icon={isDark() ? "sun" : "moon"}
              onSelect={() => {
                setColorScheme(isDark() ? "light" : "dark");
                log("ran Toggle theme");
              }}
            />
            <Item label="Sync now" icon="refresh-cw" onSelect={sync} />
          </MenuPanel>
        </Menu>
        <Button label="Open the commands" variant="secondary" onPress={() => open.set(true)} />
      </Card>
    );
  }

  function Events() {
    return (
      <Card icon="system" title="Events" subtitle="onOpenChange with its reason, and what was chosen">
        <If when={events().length > 0} else={<Caption label="Open a menu" />}>
          <View style={{ gap: 4 }}>
            <Each of={events()}>
              {(e, i) => <Text style={{ fontSize: 12, fontFamily: mono, color: i() === 0 ? colors.text : colors.faint }}>{e()}</Text>}
            </Each>
          </View>
        </If>
      </Card>
    );
  }

  return <DemoPage cards={[MenuBar, Rows, Placement, LongList, Commands, Events]} />;
}
