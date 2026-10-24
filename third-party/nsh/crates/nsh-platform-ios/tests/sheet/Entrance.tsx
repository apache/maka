import { cleanup, mount, signal, Text, View } from "nsh";
import { DockArea, Menu, Sheet } from "nsh/base";
import type { DockAreaRef } from "nsh/base";

function Body(props: { asynchronous?: boolean; close: () => void }) {
  const height = signal(300);
  const timer = props.asynchronous ? setTimeout(() => height.set(500), 80) : undefined;
  cleanup(() => clearTimeout(timer));
  return (
    <View style={{ height: height(), backgroundColor: "#ffffff" }}>
      <Text>{`Extent ${height()}`}</Text>
      <View testID="entrance-close" onPress={props.close} style={{ height: 44 }}><Text>Close panel</Text></View>
      <Text>Lazy body</Text>
    </View>
  );
}

function App() {
  const opened = signal(0);
  const closed = signal(0);
  const sheet = signal(false);
  const menu = signal(false);
  const mode = signal("Default");
  const taps = signal(0);
  let dock: DockAreaRef | undefined;
  const panelStyle = { paddingTop: 8, paddingBottom: 46, backgroundColor: "#ffffff" };
  const backdropStyle = { backgroundColor: "rgba(0,0,0,0.4)" };
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#eeeeee" }}>
      <Text>{`opened:${opened()} closed:${closed()}`}</Text>
      <Each of={["Default", "Swipe", "Async", "Menu"]}>
        {(name) => <View testID={`open-${name()}`} style={{ height: 44 }} onPress={() => {
          mode.set(name());
          if (name() === "Menu") menu.set(true); else sheet.set(true);
        }}><Text>{name()}</Text></View>}
      </Each>
      <View testID="open-dock" style={{ height: 44 }} onPress={() => dock?.toggleDock("bottom")}><Text>Dock</Text></View>
      <View testID="underlying" style={{ height: 44 }} onPress={() => taps.update((n) => n + 1)}><Text>{`taps:${taps()}`}</Text></View>
      <Sheet open={sheet()} closeOnSwipe={mode() !== "Default"} popupStyle={panelStyle} backdropStyle={backdropStyle}
        onOpenChange={(next) => sheet.set(next)} onOpen={() => opened.update((n) => n + 1)} onClose={() => closed.update((n) => n + 1)}>
        <Body asynchronous={mode() === "Async"} close={() => sheet.set(false)} />
      </Sheet>
      <Menu open={menu()} popupStyle={panelStyle} backdropStyle={backdropStyle}
        onOpenChange={(next) => menu.set(next)} onOpen={() => opened.update((n) => n + 1)} onClose={() => closed.update((n) => n + 1)}>
        <Body close={() => menu.set(false)} />
      </Menu>
      <DockArea ref={(value) => dock = value} compact class="flex-1"
        defaultLayout={{ center: { type: "tabs", panels: ["main"] }, bottom: { layout: { type: "tabs", panels: ["tools"] }, size: 260 } }}
        tabBarClass="h-6" sheetClass="bg-white" backdropStyle={backdropStyle}
        renderTab={(tab) => <Text>{tab.panel}</Text>}
        renderPanel={(panel) => panel.id === "tools" ? <View><Text>Dock body</Text><View testID="dock-close" style={{ height: 44 }} onPress={() => dock?.toggleDock("bottom")}><Text>Close dock</Text></View></View> : <Text>Center</Text>} />
    </View>
  );
}

mount(App);
