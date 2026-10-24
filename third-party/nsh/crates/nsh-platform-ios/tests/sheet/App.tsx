import { mount, Scroll, signal, Text, View } from "nsh";
import { Sheet } from "nsh/base";

function App() {
  const open = signal(false);
  const mode = signal("Short");
  const enabled = signal(true);
  const closed = signal(0);
  const reason = signal("none");
  const cancelled = signal(0);
  const scrollY = signal(0);
  const taps = signal(0);
  const show = (next: string) => {
    mode.set(next);
    enabled.set(next !== "Default");
    scrollY.set(0);
    open.set(true);
  };
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`closed:${closed()} reason:${reason()} cancel:${cancelled()}`}</Text>
      <Text>{`scroll:${Math.round(scrollY())}`}</Text>
      <Text>{`taps:${taps()}`}</Text>
      <Each of={["Short", "Scroll", "Short scroll", "Default", "Decline"]}>
        {(name) => <View onPress={() => show(name())} style={{ height: 44 }}><Text>{name()}</Text></View>}
      </Each>
      <View onPress={() => taps.update((n) => n + 1)} style={{ height: 44 }}><Text>Underlying button</Text></View>
      <Sheet
        open={open()}
        closeOnSwipe={enabled()}
        popupStyle={{ backgroundColor: "#ffffff", borderTopLeftRadius: 18, borderTopRightRadius: 18 }}
        backdropStyle={{ backgroundColor: "rgba(0,0,0,0.6)" }}
        onOpenChange={(next, why) => {
          reason.set(why);
          if (mode() !== "Decline") open.set(next);
        }}
        onCancel={() => cancelled.update((n) => n + 1)}
        onClose={() => closed.update((n) => n + 1)}
      >
        <View testID="handle" style={{ height: 44, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 40, height: 4, backgroundColor: "#666666", borderRadius: 2 }} />
        </View>
        <View style={{ flexDirection: "row", height: 44 }}>
          <View onPress={() => open.set(false)} style={{ flex: 1 }}><Text>Close</Text></View>
          <View onPress={() => enabled.set(!enabled())} style={{ flex: 1 }}><Text>{enabled() ? "Lock" : "Unlock"}</Text></View>
          <View onPress={() => {
            open.set(false);
            setTimeout(() => open.set(true), 40);
          }} style={{ flex: 1 }}><Text>Reopen</Text></View>
          <View onPress={() => {
            open.set(false);
            setTimeout(() => open.set(true), 40);
            setTimeout(() => open.set(false), 80);
            setTimeout(() => open.set(true), 220);
          }} style={{ flex: 1 }}><Text>Cycle</Text></View>
        </View>
        <If when={mode() === "Scroll" || mode() === "Short scroll"} else={<View style={{ height: 180 }}><Text>Sheet body</Text></View>}>
          <Scroll testID="scroll" style={{ height: 400 }} onScroll={(e) => scrollY.set(e.offset.y)}>
            <View testID="scroll-start" style={{ height: 60 }}><Text>Sheet body</Text></View>
            <If when={mode() === "Scroll"}>
              <Each of={Array.from({ length: 24 }, (_, i) => i)}>
                {(i) => <View testID={`row-${i()}`} style={{ height: 44 }}><Text>{`Row ${i()}`}</Text></View>}
              </Each>
            </If>
          </Scroll>
        </If>
      </Sheet>
    </View>
  );
}

mount(App);
