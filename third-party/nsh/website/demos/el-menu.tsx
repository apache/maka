import { type JSX, mount, signal, Text, View } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator, type OpenChangeReason, Submenu } from "nsh/base";
import { button, buttonText, desktop, Inspector, MenuMark, menuIndicator, Panel, PopIn, type PopupSide, Stage, tint, ui, wide } from "./palette";

/** A sheet at the bottom on phones; on desktops the popup's box keeps no
 * look, its `Items` have it. */
const surface = () =>
  desktop ? undefined : { ...ui().card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 30 };

/** A menu's items: on desktops on a surface that grows out of the trigger's
 * side each time it opens (`PopIn`), on phones in the sheet that slides up. */
function Items(props: { side?: PopupSide; children: JSX.Element }) {
  if (!desktop) return props.children;
  return (
    <PopIn side={props.side} style={{ ...ui().card, borderRadius: 12, padding: 5, minWidth: 210 }}>
      {props.children}
    </PopIn>
  );
}

const backdrop = { backgroundColor: "rgba(0,0,0,0.45)" };
const rowHeight = () => (desktop ? 32 : 46);
const row = () => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 8, height: rowHeight(), paddingHorizontal: 10, borderRadius: 8 });

/**
 * One row. A checkable row (`checked`) leads with its mark: a check for a
 * setting, a dot for one choice of a group (`radio`), which fades in as the
 * app checks the item; rows of the same menu keep the mark's room so their
 * labels line up (`inset`).
 */
function Item(props: { label: string; onSelect?: () => void; checked?: boolean; radio?: boolean; inset?: boolean; disabled?: boolean; keepOpen?: boolean; danger?: boolean }) {
  return (
    <MenuItem
      onSelect={props.onSelect}
      disabled={props.disabled}
      checked={props.checked}
      role={props.radio ? "menuitemradio" : undefined}
      indicatorClass={menuIndicator}
      indicator={props.checked === undefined ? undefined : <MenuMark kind={props.radio ? "dot" : "check"} tint={ui().accent} />}
      closeOnSelect={!props.keepOpen}
      hoverStyle={{ backgroundColor: tint(ui().accent, 0.08), borderColor: tint(ui().accent, 0.24) }}
      activeStyle={{ backgroundColor: tint(ui().accent, 0.14), borderColor: tint(ui().accent, 0.34) }}
      disabledStyle={{ opacity: 0.35 }}
      style={{ ...row(), borderWidth: 1, borderColor: "transparent" }}
    >
      <If when={props.inset}>
        <View style={{ width: 16 }} />
      </If>
      <Text style={{ flex: 1, fontSize: 14, color: props.danger ? ui().down : ui().text }}>{props.label}</Text>
    </MenuItem>
  );
}

function Separator() {
  return <MenuSeparator style={{ height: 1, marginVertical: 4, marginHorizontal: 6, backgroundColor: ui().border }} />;
}

function Share(props: { onSelect: (what: string) => void }) {
  return (
    <Submenu
      trigger={
        <View hoverStyle={{ backgroundColor: tint(ui().accent, 0.08), borderColor: tint(ui().accent, 0.24) }} activeStyle={{ backgroundColor: tint(ui().accent, 0.14), borderColor: tint(ui().accent, 0.34) }} style={{ ...row(), borderWidth: 1, borderColor: "transparent" }}>
          <Text style={{ flex: 1, fontSize: 14, color: ui().text }}>Share</Text>
          <Text style={{ fontSize: 14, color: ui().faint }}>›</Text>
        </View>
      }
      back={
        <View activeStyle={{ backgroundColor: tint(ui().accent, 0.14), borderColor: tint(ui().accent, 0.34) }} style={{ ...row(), borderWidth: 1, borderColor: "transparent" }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: ui().accent }}>‹ Share</Text>
        </View>
      }
    >
      <Items side="right">
        <Item label="Mail" onSelect={() => props.onSelect("Mail")} />
        <Item label="Messages" onSelect={() => props.onSelect("Messages")} />
        <Item label="Copy link" onSelect={() => props.onSelect("Copy link")} />
      </Items>
    </Submenu>
  );
}

/** A group's title: not an item, nothing to press. */
function Label(props: { text: string }) {
  return <Text style={{ fontSize: 12, fontWeight: "600", color: ui().faint, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 2 }}>{props.text}</Text>;
}

const SORTS = ["Name", "Date modified", "Size"];

function App() {
  const last = signal("—");
  const reasons = signal<string[]>([]);
  const hidden = signal(false);
  const sidebar = signal(true);
  const minimap = signal(false);
  const sort = signal("Name");
  const pinned = signal(false);
  const changed = (name: string) => ({ open, reason }: { open: boolean; reason: OpenChangeReason }) =>
    reasons.set([`${name} ${open ? "opened" : "closed"} · ${reason}`, ...reasons()].slice(0, 8));
  const choose = (what: string) => last.set(what);
  const menu = () => (
    <Menu
      offset={4}
      margin={8}
      popupStyle={surface()}
      backdropStyle={backdrop}
      onOpenChange={changed("File")}
      trigger={
        <View {...button("secondary", { align: "flex-start" })}>
          <Text style={buttonText()}>File ▾</Text>
        </View>
      }
    >
      <Items>
        <Item label="New" onSelect={() => choose("New")} />
        <Item label="Open…" onSelect={() => choose("Open…")} />
        <Item label="Paste" disabled />
        <Separator />
        <Share onSelect={(what) => choose(`Share › ${what}`)} />
        <Separator />
        <Item label="Delete" danger onSelect={() => choose("Delete")} />
      </Items>
    </Menu>
  );
  const view = () => (
    <Menu
      offset={4}
      margin={8}
      popupStyle={surface()}
      backdropStyle={backdrop}
      onOpenChange={changed("View")}
      trigger={
        <View {...button("secondary", { align: "flex-start" })}>
          <Text style={buttonText()}>View ▾</Text>
        </View>
      }
    >
      <Items>
        {/* Settings keep the menu open: each shows its new value at once. */}
        <Item label="Show sidebar" checked={sidebar()} keepOpen onSelect={() => sidebar.set(!sidebar())} />
        <Item label="Show minimap" checked={minimap()} keepOpen onSelect={() => minimap.set(!minimap())} />
        <Item label="Show hidden files" checked={hidden()} keepOpen onSelect={() => hidden.set(!hidden())} />
        <Separator />
        <Label text="Sort by" />
        {/* One choice of a group: choosing closes the menu. */}
        <Each of={SORTS}>{(by) => <Item label={by()} radio checked={sort() === by()} onSelect={() => sort.set(by())} />}</Each>
      </Items>
    </Menu>
  );
  const context = () => (
    <ContextMenu
      margin={8}
      popupStyle={surface()}
      backdropStyle={backdrop}
      onOpenChange={changed("Context")}
      trigger={
        <View
          style={{
            height: wide() ? 220 : 150,
            borderRadius: 14,
            borderWidth: 2,
            borderStyle: "dashed",
            borderColor: ui().faint,
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: ui().text }}>{pinned() ? "ContextMenu · pinned" : "ContextMenu"}</Text>
          <Text style={{ fontSize: 13, color: ui().muted }}>{desktop ? "Right click here" : "Hold a finger here"}</Text>
        </View>
      }
    >
      <Items>
        <Item label="Pinned" checked={pinned()} onSelect={() => pinned.set(!pinned())} />
        <Item label="Copy" inset onSelect={() => choose("Copy")} />
        <Item label="Rename" inset onSelect={() => choose("Rename")} />
        <Separator />
        <Item label="Delete" inset danger onSelect={() => choose("Delete")} />
      </Items>
    </ContextMenu>
  );
  const panels = () => (
    <>
      <Panel title="onSelect · checked">
        <Text style={{ fontSize: 13, color: ui().text }}>{last()}</Text>
        <Text style={{ fontSize: 13, color: ui().muted }}>
          sidebar {sidebar() ? "on" : "off"} · minimap {minimap() ? "on" : "off"} · hidden files {hidden() ? "shown" : "hidden"} · by {sort()} · {pinned() ? "pinned" : "not pinned"}
        </Text>
      </Panel>
      <Panel title="onOpenChange({ open, reason })" grow>
        <View style={{ gap: 2 }}>
          <Each of={reasons()}>{(e, i) => <Text style={{ fontSize: 12, color: i() === 0 ? ui().text : ui().faint }}>{e()}</Text>}</Each>
        </View>
      </Panel>
    </>
  );
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>menu</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click File; hover Share to open its submenu. View has settings and a choice of one. Right click the box below" : "Tap File: a sheet; Share shows its items in place. View has settings and a choice of one"}
      </Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <Stage>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {menu()}
                {view()}
              </View>
              {context()}
            </Stage>
            <Inspector>{panels()}</Inspector>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {menu()}
              {view()}
            </View>
            {context()}
            {panels()}
          </>
        )
      }
    </View>
  );
}

mount(App);
