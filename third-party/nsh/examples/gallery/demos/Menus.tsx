import { type JSX, Scroll, signal, Text, View } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator, type OpenChangeReason, Submenu } from "nsh/base";
import { platform } from "nsh";
import { keymap } from "nsh";
import { Icon } from "../icons";
import { Badge, Button, Caption, Card, colors, DemoPage, finish, isDark, mono, radius, Row, Segmented, Tip } from "../ui";

// The look of every menu here is the gallery's: `nsh/base` draws none.

/** The popup on desktops, the sheet at the bottom on touch screens. */
const surface = () =>
  platform.idiom === "desktop"
    ? {
        backgroundColor: colors.raised,
        borderRadius: radius.inset,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 6,
        minWidth: 220,
        ...finish.raised,
      }
    : {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: 10,
        paddingTop: 10,
        paddingBottom: 34,
      };

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };

/** An item under the pointer, and pressed: the website's current item, a
 * citrus tint with a hairline of it (`global.css` `.sidebar-item.active`). */
const hovered = () =>
  isDark()
    ? { backgroundColor: "rgba(200,242,109,0.08)", borderColor: "rgba(200,242,109,0.22)" }
    : { backgroundColor: "rgba(124,170,20,0.10)", borderColor: "rgba(124,170,20,0.26)" };
const pressed = () =>
  isDark()
    ? { backgroundColor: "rgba(200,242,109,0.14)", borderColor: "rgba(200,242,109,0.32)" }
    : { backgroundColor: "rgba(124,170,20,0.16)", borderColor: "rgba(124,170,20,0.36)" };

/** One row of a menu: a mark (a check, a dot, an icon), the label, a note (a shortcut, a value). */
function Item(props: {
  label: string;
  onSelect?: () => void;
  shortcut?: string;
  note?: string;
  mark?: "check" | "dot" | null;
  disabled?: boolean;
  danger?: boolean;
  keepOpen?: boolean;
}) {
  const height = platform.idiom === "desktop" ? 32 : 46;
  return (
    <MenuItem
      onSelect={props.onSelect}
      disabled={props.disabled}
      closeOnSelect={!props.keepOpen}
      hoverStyle={hovered()}
      activeStyle={pressed()}
      disabledStyle={{ opacity: 0.35 }}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, height, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, borderColor: "transparent" }}
    >
      <Text style={{ flex: 1, fontSize: 14, color: props.danger ? colors.danger : colors.text }}>{props.label}</Text>
      <If when={props.shortcut ?? props.note}>
        <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{props.shortcut ?? props.note}</Text>
      </If>
      {/* The check or the dot at the trailing edge. */}
      <If when={props.mark !== undefined}>
        <View style={{ width: 16, alignItems: "center" }}>
          <If when={props.mark === "check"}>
            <Icon name="check" size={14} tint={colors.accent} />
          </If>
          <If when={props.mark === "dot"}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
          </If>
        </View>
      </If>
    </MenuItem>
  );
}

/** The row that opens a submenu, and the row a sheet shows to come back. */
function SubmenuOf(props: { label: string; children: JSX.Element; disabled?: boolean }) {
  const height = platform.idiom === "desktop" ? 32 : 46;
  return (
    <Submenu
      disabled={props.disabled}
      trigger={
        <View
          hoverStyle={hovered()}
          activeStyle={pressed()}
          style={{ flexDirection: "row", alignItems: "center", height, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, borderColor: "transparent", opacity: props.disabled ? 0.35 : 1 }}
        >
          <Text style={{ flex: 1, fontSize: 14, color: colors.text }}>{props.label}</Text>
          <Icon name="chevron" size={14} tint={colors.faint} />
        </View>
      }
      back={
        <View activeStyle={pressed()} style={{ flexDirection: "row", alignItems: "center", gap: 6, height, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, borderColor: "transparent" }}>
          <Icon name="back" size={14} tint={colors.accent} />
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>{props.label}</Text>
        </View>
      }
    >
      {props.children}
    </Submenu>
  );
}

/** A group's title: not an item, nothing to press. */
function Label(props: { text: string }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 0.6, color: colors.faint, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4 }}>
      {props.text.toUpperCase()}
    </Text>
  );
}

function Separator() {
  return <MenuSeparator style={{ height: 1, marginVertical: 4, marginHorizontal: 4, backgroundColor: colors.line }} />;
}

/** A chip that opens a menu. */
function Chip(props: { label: string; icon?: "plus" | "search" | "star" }) {
  return (
    <View
      activeStyle={{ backgroundColor: colors.border }}
      hoverStyle={{ backgroundColor: colors.border }}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 12, height: 34, justifyContent: "center", borderRadius: radius.control, backgroundColor: colors.raised, ...finish.raised }}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} size={14} tint={colors.muted} />
      </If>
      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{props.label}</Text>
    </View>
  );
}

const ZONES = [
  "UTC−10 Honolulu", "UTC−8 Los Angeles", "UTC−7 Denver", "UTC−6 Chicago", "UTC−5 New York", "UTC−3 São Paulo",
  "UTC±0 London", "UTC+1 Berlin", "UTC+2 Cairo", "UTC+3 Moscow", "UTC+4 Dubai", "UTC+5:30 Mumbai", "UTC+7 Bangkok",
  "UTC+8 Hong Kong", "UTC+8 Shanghai", "UTC+8 Singapore", "UTC+9 Tokyo", "UTC+9 Seoul", "UTC+10 Sydney", "UTC+12 Auckland",
];

type File = { id: number; name: string; starred: boolean };

/**
 * Menus of `nsh/base`, as complete as an app's: a menu bar whose menus have
 * shortcuts, submenus three levels deep, checkable items and a choice of one,
 * group titles, disabled and destructive items; menus on the rows of a list
 * (the secondary button or a held finger, and a ⋯ button); where a popup
 * goes; a long menu that scrolls; a menu a shortcut opens. On desktops they
 * are popups with cascading submenus, on touch screens sheets whose
 * submenus take the place of their items.
 */
export function Menus() {
  const events = signal<string[]>([]);
  const log = (what: string) => events.set([what, ...events()].slice(0, 6));
  const changed = (menu: string) => (open: boolean, reason: OpenChangeReason) => log(`${menu} ${open ? "opened" : "closed"} · ${reason}`);

  function MenuBar() {
    const history = signal<string[]>([]);
    const undone = signal<string[]>([]);
    const sidebar = signal(true);
    const statusBar = signal(false);
    const zoom = signal<"Small" | "Medium" | "Large">("Medium");
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
      "mod+alt+shift+z": redo,
    });
    const key = (k: string) => (platform.idiom === "desktop" ? keymap.label(k) : undefined);
    return (
      <Card icon="lists" title="Menu bar" subtitle={platform.idiom === "desktop" ? "Hover across submenus; the shortcuts work too" : "Each menu a sheet; submenus take its place"}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Menu offset={4} margin={8} popupStyle={surface()} backdropStyle={backdrop} onOpenChange={changed("File")} trigger={<Chip label="File" />}>
            <Item label="New document" shortcut={key("mod+alt+n")} onSelect={() => act("New document")} />
            <Item label="New window" onSelect={() => act("New window")} />
            <SubmenuOf label="Open recent">
              <Each of={recent()}>{(name) => <Item label={name()} onSelect={() => act(`Open ${name()}`)} />}</Each>
              <Separator />
              <Item label="Clear recent" disabled={recent().length === 0} onSelect={() => recent.set([])} />
            </SubmenuOf>
            <Separator />
            <Item label="Save" shortcut={key("mod+alt+s")} onSelect={() => act("Save")} />
            <SubmenuOf label="Export as">
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
            <Item label="Delete document" danger onSelect={() => act("Delete document")} />
          </Menu>
          <Menu offset={4} margin={8} popupStyle={surface()} backdropStyle={backdrop} onOpenChange={changed("Edit")} trigger={<Chip label="Edit" />}>
            <Item label={history().length ? `Undo ${history().at(-1)}` : "Undo"} shortcut={key("mod+alt+z")} disabled={history().length === 0} onSelect={undo} />
            <Item label={undone().length ? `Redo ${undone().at(-1)}` : "Redo"} shortcut={key("mod+alt+shift+z")} disabled={undone().length === 0} onSelect={redo} />
            <Separator />
            <Label text="Clipboard" />
            <Item label="Cut" onSelect={() => act("Cut")} />
            <Item label="Copy" onSelect={() => act("Copy")} />
            <Item label="Paste" onSelect={() => act("Paste")} />
          </Menu>
          <Menu offset={4} margin={8} popupStyle={surface()} backdropStyle={backdrop} onOpenChange={changed("View")} trigger={<Chip label="View" />}>
            <Label text="Show" />
            <Item label="Sidebar" mark={sidebar() ? "check" : null} keepOpen onSelect={() => sidebar.set(!sidebar())} />
            <Item label="Status bar" mark={statusBar() ? "check" : null} keepOpen onSelect={() => statusBar.set(!statusBar())} />
            <Separator />
            <Label text="Zoom" />
            <Each of={["Small", "Medium", "Large"] as const}>
              {(size) => <Item label={size()} mark={zoom() === size() ? "dot" : null} keepOpen onSelect={() => zoom.set(size())} />}
            </Each>
          </Menu>
        </View>
        <Caption label={`Sidebar ${sidebar() ? "on" : "off"} · status bar ${statusBar() ? "on" : "off"} · zoom ${zoom()}`} />
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
      <>
        <Item label="Open" onSelect={() => log(`open ${file().name}`)} />
        <Item label={file().starred ? "Unstar" : "Star"} onSelect={() => update(file().id, (f) => ({ ...f, starred: !f.starred }))} />
        <Item
          label="Duplicate"
          onSelect={() => {
            const f = file();
            const at = files().findIndex((x) => x.id === f.id);
            const copy = { id: next++, name: f.name.replace(/(\.[^.]+)?$/, " copy$1"), starred: false };
            files.set([...files().slice(0, at + 1), copy, ...files().slice(at + 1)]);
          }}
        />
        <SubmenuOf label="Move to">
          <Item label="Documents" onSelect={() => log(`moved ${file().name} to Documents`)} />
          <Item label="Archive" onSelect={() => log(`moved ${file().name} to Archive`)} />
        </SubmenuOf>
        <Separator />
        <Item label="Delete" danger onSelect={() => files.set(files().filter((f) => f.id !== file().id))} />
      </>
    );
    return (
      <Card icon="photos" title="On the rows of a list" subtitle={platform.idiom === "desktop" ? "Right click a row, or its ⋯ button" : "Hold a finger on a row, or press its ⋯"}>
        <If when={files().length > 0} else={<Caption label="No files left" />}>
          <View>
            <Each of={files()} key={(f) => f.id}>
              {(file, i) => (
                <ContextMenu margin={8} popupStyle={surface()} backdropStyle={backdrop} onOpenChange={changed(file().name)} trigger={
                  <Row first={i() === 0}>
                    <Icon name={file().starred ? "star" : "text"} size={16} tint={file().starred ? colors.accent : colors.muted} />
                    <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: colors.text }}>{file().name}</Text>
                    <Menu align="end" offset={4} margin={8} popupStyle={surface()} backdropStyle={backdrop} trigger={
                      <View accessibilityLabel={`Actions for ${file().name}`} tooltip={<Tip label="More actions" />} hitSlop={8} activeStyle={{ opacity: 0.5 }} style={{ paddingHorizontal: 8, height: 28, justifyContent: "center" }}>
                        <Text style={{ fontSize: 18, color: colors.muted }}>⋯</Text>
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
      <Card icon="components" title="Where it goes" subtitle={platform.idiom === "desktop" ? "The side and alignment; it flips where there is no room" : "Phones show menus as sheets: try a desktop"}>
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
          <Menu placement={placement()} align={align()} offset={6} margin={8} popupStyle={surface()} backdropStyle={backdrop} onOpenChange={changed("Placed")} trigger={<Chip label={`${placement()} · ${align()}`} />}>
            <Item label="One" onSelect={() => log("chose One")} />
            <Item label="Two" onSelect={() => log("chose Two")} />
            <Item label="Three" onSelect={() => log("chose Three")} />
          </Menu>
        </View>
      </Card>
    );
  }

  function LongList() {
    const zone = signal("UTC+8 Hong Kong");
    return (
      <Card icon="scroll" title="A long menu" subtitle="Twenty choices in a menu that scrolls">
        <Menu offset={4} margin={8} popupStyle={{ ...surface(), padding: 0 }} backdropStyle={backdrop} onOpenChange={changed("Time zone")} trigger={<Chip label={zone()} icon="search" />}>
          <Scroll style={{ maxHeight: platform.idiom === "desktop" ? 280 : 360 }} contentStyle={{ padding: 6 }}>
            <Each of={ZONES}>{(z) => <Item label={z()} mark={zone() === z() ? "check" : null} onSelect={() => zone.set(z())} />}</Each>
          </Scroll>
        </Menu>
      </Card>
    );
  }

  function Commands() {
    const open = signal(false);
    keymap.bind("mod+shift+p", () => open.set(!open()));
    return (
      <Card icon="spark" title="Opened by the app" subtitle="A controlled menu: a button or a shortcut opens it" right={platform.idiom === "desktop" ? <Badge label={keymap.label("mod+shift+p")} /> : undefined}>
        <Menu
          open={open()}
          onOpenChange={(next, reason) => {
            open.set(next);
            log(`commands ${next ? "opened" : "closed"} · ${reason}`);
          }}
          offset={4}
          margin={8}
          popupStyle={surface()}
          backdropStyle={backdrop}
          trigger={<Chip label="Commands" icon="plus" />}
        >
          <Label text="Commands" />
          <Item label="New note" onSelect={() => log("ran New note")} />
          <Item label="Toggle theme" onSelect={() => log("ran Toggle theme")} />
          <Item label="Sync now" onSelect={() => log("ran Sync now")} />
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
