import { mount, signal, Text, View } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator, type OpenChangeReason, Submenu } from "nsh/base";
import { backdrop, button, buttonText, desktop, Inspector, MenuLabel, MenuMark, MenuPanel, menuIndicator, menuItemLabel, menuItemLook, menuItemSize, menuSeparator, menuSheet, Panel, Stage, SubmenuBack, SubmenuRow, ui, wide } from "./palette";

/**
 * One row (`menuItemLook`: the hover and the keyboard's highlight alike).
 * A checkable row (`checked`) leads with its mark: a check for a setting, a
 * dot for one choice of a group (`radio`), which fades in as the app checks
 * the item; rows of the same menu keep the mark's room so their labels line
 * up (`inset`).
 */
function Item(props: { label: string; onSelect?: () => void; checked?: boolean; radio?: boolean; inset?: boolean; disabled?: boolean; keepOpen?: boolean; danger?: boolean }) {
  return (
    <MenuItem
      onSelect={props.onSelect}
      disabled={props.disabled}
      checked={props.checked}
      role={props.radio ? "menuitemradio" : undefined}
      indicatorClass={menuIndicator}
      indicator={props.checked === undefined ? undefined : <MenuMark kind={props.radio ? "dot" : "check"} size={menuItemSize.icon} tint={ui().accent} />}
      closeOnSelect={!props.keepOpen}
      {...menuItemLook()}
    >
      <If when={props.inset}>
        <View style={{ width: menuItemSize.icon }} />
      </If>
      <Text style={menuItemLabel({ danger: props.danger })}>{props.label}</Text>
    </MenuItem>
  );
}

function Share(props: { onSelect: (what: string) => void }) {
  return (
    <Submenu offset={4} trigger={<SubmenuRow label="Share" />} back={<SubmenuBack label="Share" />}>
      <MenuPanel side="right">
        <Item label="Mail" onSelect={() => props.onSelect("Mail")} />
        <Item label="Messages" onSelect={() => props.onSelect("Messages")} />
        <Item label="Copy link" onSelect={() => props.onSelect("Copy link")} />
      </MenuPanel>
    </Submenu>
  );
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
      popupStyle={menuSheet()}
      backdropStyle={backdrop()}
      onOpenChange={changed("File")}
      trigger={
        <View {...button("secondary", { align: "flex-start" })}>
          <Text style={buttonText()}>File ▾</Text>
        </View>
      }
    >
      <MenuPanel>
        <Item label="New" onSelect={() => choose("New")} />
        <Item label="Open…" onSelect={() => choose("Open…")} />
        <Item label="Paste" disabled />
        <MenuSeparator style={menuSeparator()} />
        <Share onSelect={(what) => choose(`Share › ${what}`)} />
        <MenuSeparator style={menuSeparator()} />
        <Item label="Delete" danger onSelect={() => choose("Delete")} />
      </MenuPanel>
    </Menu>
  );
  const view = () => (
    <Menu
      offset={4}
      margin={8}
      popupStyle={menuSheet()}
      backdropStyle={backdrop()}
      onOpenChange={changed("View")}
      trigger={
        <View {...button("secondary", { align: "flex-start" })}>
          <Text style={buttonText()}>View ▾</Text>
        </View>
      }
    >
      <MenuPanel>
        {/* Settings keep the menu open: each shows its new value at once. */}
        <Item label="Show sidebar" checked={sidebar()} keepOpen onSelect={() => sidebar.set(!sidebar())} />
        <Item label="Show minimap" checked={minimap()} keepOpen onSelect={() => minimap.set(!minimap())} />
        <Item label="Show hidden files" checked={hidden()} keepOpen onSelect={() => hidden.set(!hidden())} />
        <MenuSeparator style={menuSeparator()} />
        <MenuLabel text="Sort by" />
        {/* One choice of a group: choosing closes the menu. */}
        <Each of={SORTS}>{(by) => <Item label={by()} radio checked={sort() === by()} onSelect={() => sort.set(by())} />}</Each>
      </MenuPanel>
    </Menu>
  );
  const context = () => (
    <ContextMenu
      margin={8}
      popupStyle={menuSheet()}
      backdropStyle={backdrop()}
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
      <MenuPanel>
        <Item label="Pinned" checked={pinned()} onSelect={() => pinned.set(!pinned())} />
        <Item label="Copy" inset onSelect={() => choose("Copy")} />
        <Item label="Rename" inset onSelect={() => choose("Rename")} />
        <MenuSeparator style={menuSeparator()} />
        <Item label="Delete" inset danger onSelect={() => choose("Delete")} />
      </MenuPanel>
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
