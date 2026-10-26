// A case of the API's test suite (docs/dev/compatibility.md): the popups of
// `nsh/base` on a phone, on the core's overlays: a `Popover` anchored to its
// trigger (controlled and not; its side, alignment, gap and margin; Escape
// heard without closing), a `Menu` presented as a sheet whose `Submenu`
// replaces its items, its `MenuItem`s (disabled, kept open, labelled) and a
// `MenuSeparator`, a `ContextMenu` a held finger opens, `Tooltip`s given as
// elements' `tooltip` the app opens (a touch screen shows none of its own, nor an
// element's `tooltip`), a `Sheet` at an edge over a backdrop; every part
// styled by the app, every change reported with its reason, their
// lifecycles (`onOpen`, `onClose`) and Escape or back heard (`onCancel`). Its script
// checks each.
import { Text, View, signal } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator, Popover, Sheet, Submenu, Tooltip } from "nsh/base";

function App() {
  const log = signal("Log: none");
  const pop = signal(true);
  const sheet = signal(false);
  const swipeSheet = signal(false);
  const ctxOff = signal(false);
  const ctx = signal(false);
  const menu = signal(false);
  const tip = signal(false);
  const tipOn = signal(false);
  const life = signal("Life: none");
  const heard = signal("Heard: none");
  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, paddingRight: 20, gap: 8 }}>
      <Text>{log()}</Text>
      <Popover
        open={pop()}
        onOpenChange={(open, reason) => {
          pop.set(open);
          log.set(`Log: popover ${open} ${reason}`);
        }}
        onOpen={() => life.set("Life: popover open")}
        onClose={() => life.set("Life: popover closed")}
        onCancel={() => log.set("Log: popover cancel")}
        closeOnEscape={false}
        placement="top"
        align="end"
        offset={6}
        margin={30}
        popupClass="bg-[#123456]"
        popupStyle={{ width: 80 }}
        trigger={<View style={{ height: 30 }}><Text>PopTrigger</Text></View>}
      >
        <Text>PopoverBody</Text>
      </Popover>
      <Popover defaultOpen trigger={<View style={{ height: 30 }}><Text>OwnTrigger</Text></View>}>
        <Text>OwnBody</Text>
      </Popover>
      <Menu
        open={menu()}
        onOpenChange={(open, reason) => {
          menu.set(open);
          log.set(`Log: menu ${open} ${reason}`);
        }}
        onOpen={() => life.set("Life: menu open")}
        onClose={() => life.set("Life: menu closed")}
        onCancel={() => heard.set("Heard: menu cancel")}
        popupClass="bg-[#00ff00]"
        popupStyle={{ padding: 4 }}
        backdropClass="bg-[#000000]"
        backdropStyle={{ opacity: 0.5 }}
        trigger={<View style={{ height: 30 }}><Text>MenuTrigger</Text></View>}
      >
        <MenuItem onSelect={() => log.set("Log: chose New")}><Text>NewItem</Text></MenuItem>
        <MenuItem disabled onSelect={() => log.set("Log: chose Off")}><Text>OffItem</Text></MenuItem>
        <MenuItem closeOnSelect={false} accessibilityLabel="Keep the menu" onSelect={() => log.set("Log: chose Keep")}>
          <Text>KeepItem</Text>
        </MenuItem>
        <MenuSeparator testID="separator" style={{ height: 1 }} />
        <Submenu
          trigger={<View><Text>ShareItem</Text></View>}
          back={<View><Text>BackRow</Text></View>}
        >
          <MenuItem onSelect={() => log.set("Log: chose Mail")}><Text>MailItem</Text></MenuItem>
        </Submenu>
        <Submenu disabled trigger={<View><Text>LockedItem</Text></View>}>
          <MenuItem><Text>HiddenItem</Text></MenuItem>
        </Submenu>
      </Menu>
      <ContextMenu
        open={ctx()}
        disabled={ctxOff()}
        onOpenChange={(open, reason) => {
          ctx.set(open);
          log.set(`Log: context ${open} ${reason}`);
        }}
        onOpen={() => life.set("Life: context open")}
        onClose={() => life.set("Life: context closed")}
        onCancel={() => heard.set("Heard: context cancel")}
        popupClass="bg-[#ff0000]"
        popupStyle={{ padding: 2 }}
        backdropClass="bg-[#0000ff]"
        backdropStyle={{ opacity: 0.25 }}
        trigger={<View style={{ height: 30 }}><Text>HoldArea</Text></View>}
      >
        <MenuItem onSelect={() => log.set("Log: chose Copy")}><Text>CopyItem</Text></MenuItem>
      </ContextMenu>
      <View onPress={() => ctxOff.set(!ctxOff())}><Text>ToggleContext</Text></View>
      <View onPress={() => ctx.set(true)}><Text>ShowContext</Text></View>
      <View
        onPress={() => tipOn.set(!tipOn())}
        style={{ height: 30 }}
        tooltip={
          <Tooltip
            open={tipOn()}
            placement="bottom"
            align="start"
            offset={4}
            margin={30}
            class="bg-[#333333]"
            style={{ width: 60 }}
            onOpenChange={(open, reason) => log.set(`Log: tooltip ${open} ${reason}`)}
          >
            <Text>TipText</Text>
          </Tooltip>
        }
      >
        <Text>TipTrigger</Text>
      </View>
      <View style={{ height: 30 }} tooltip={<Tooltip disabled defaultOpen><Text>NeverTip</Text></Tooltip>}>
        <Text>OffTrigger</Text>
      </View>
      <View style={{ height: 30 }} tooltip={<Tooltip defaultOpen><Text>ShownTip</Text></Tooltip>}>
        <Text>ShownTrigger</Text>
      </View>
      <View style={{ height: 30 }} tooltip="PropTip">
        <Text>PropTrigger</Text>
      </View>
      <View onPress={() => sheet.set(true)}><Text>OpenSheet</Text></View>
      <Sheet
        open={sheet()}
        onOpenChange={(open, reason) => {
          sheet.set(open);
          log.set(`Log: sheet ${open} ${reason}`);
        }}
        onOpen={() => life.set("Life: sheet open")}
        onClose={() => life.set("Life: sheet closed")}
        onCancel={() => log.set("Log: sheet cancel")}
        side="top"
        closeOnEscape={false}
        popupClass="bg-[#abcdef]"
        popupStyle={{ height: 50 }}
        backdropClass="bg-[#111111]"
        backdropStyle={{ opacity: 0.75 }}
      >
        <Text>SheetBody</Text>
      </Sheet>
      <View onPress={() => swipeSheet.set(true)}><Text>OpenSwipeSheet</Text></View>
      <Sheet open={swipeSheet()} closeOnSwipe onOpenChange={(next) => swipeSheet.set(next)} popupStyle={{ paddingTop: 54 }}>
        <Text style={{ height: 300 }}>SwipeSheetBody</Text>
      </Sheet>
      <Sheet defaultOpen closeOnBackdropPress={false} popupStyle={{ height: 20 }}>
        <Text>StuckSheet</Text>
      </Sheet>
      <View onPress={() => menu.set(true)}><Text>ShowMenu</Text></View>
      <Menu defaultOpen trigger={<View><Text>OtherMenu</Text></View>}>
        <MenuItem><Text>OpenAtStart</Text></MenuItem>
      </Menu>
      <View onPress={() => tip.set(true)}><Text>ShowTip</Text></View>
      <View style={{ height: 30 }} tooltip={<Tooltip open={tip()}><Text>AskedTip</Text></Tooltip>}>
        <Text>AskedTrigger</Text>
      </View>
      {/* Out of the column's flow: the lifecycle and what was heard. */}
      <View style={{ position: "absolute", left: 0, bottom: 0 }}>
        <Text>{life()}</Text>
        <Text>{heard()}</Text>
      </View>
    </View>
  );
}

export default App;
