// A case of the API's test suite (docs/dev/compatibility.md): `DockArea`
// of `nsh/base` on a phone (390 wide: the compact presentation). The
// center shows one tab group at a time, its tab bar listing every center
// panel; a tab of another group shows that group. The docks are drawers
// (`drawerClass`), one presented at a time and none at first, whatever
// the layout's `open` says: the ref presents one (`toggleDock`), a press
// on its backdrop (`backdropClass`) dismisses it, and each change is
// reported (`onDockOpenChange`) with no change to the layout. An
// uncontrolled area (`defaultLayout`) keeps its own layout.
import { Text, View, signal } from "nsh";
import { DockArea, type DockAreaRef } from "nsh/base";

export default function BaseDock() {
  const reported = signal("none");
  const docks = signal<string[]>([]);
  let area: DockAreaRef | undefined;
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 390, height: 300 }}>
        <DockArea
          ref={r => (area = r)}
          defaultLayout={{
            center: {
              type: "split",
              axis: "horizontal",
              children: [
                { type: "tabs", panels: ["a", "b"] },
                { type: "tabs", panels: ["c"] },
              ],
            },
            left: { layout: { type: "tabs", panels: ["files"] }, size: 240 },
          }}
          onLayoutChange={({ layout }) => reported.set(layout.left?.open ? "left open" : "left closed")}
          onDockOpenChange={({ placement, open }) => docks.set([...docks(), `${placement} ${open}`])}
          class="flex-1"
          tabBarClass="flex-row h-[24px]"
          tabClass="w-[60px]"
          drawerClass="bg-[#ffffff]"
          backdropClass="bg-[#00000066]"
          renderTab={tab => <Text>{`Tab ${tab.panel}${tab.active ? "*" : ""}`}</Text>}
          renderPanel={panel => <Text testID={`panel-${panel.id}`}>{`Panel ${panel.id}`}</Text>}
        />
      </View>
      <Text>{() => `Reported ${reported()}`}</Text>
      <Text>{() => `Docks: ${docks().join(", ")}`}</Text>
      <View testID="open-files" style={{ width: 20, height: 20 }} onPress={() => area?.toggleDock("left")} />
    </View>
  );
}
