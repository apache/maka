// A case of the API's test suite (docs/dev/compatibility.md): `DockArea`
// of `nsh/base` on a desktop, its full presentation (`compact={false}`):
// a controlled layout (`layout` and `onLayoutChange`) of two tab groups
// side by side, the first 200 wide; the tabs the app renders
// (`renderTab`, told which is displayed), the panels it renders
// (`renderPanel`, keyed by panel: a counter whose state moves with its
// panel), the drop indicator while a drag hovers a group
// (`renderDropIndicator`, `dropIndicatorClass`), what follows the
// pointer (`renderDragPreview`), the parts' classes, and
// the ref's methods (`closePanel`, `toggleZoom`) with the events they
// cause (`onPanelRemove`, `onZoomChange`, `onPanelActiveChange`).
import { Text, View, signal } from "nsh";
import { DockArea, type DockAreaLayout, type DockAreaRef, type DockNode } from "nsh/base";

function Counter(props: { id: string }) {
  const count = signal(0);
  return (
    <View style={{ flex: 1 }}>
      <Text>{() => `Count ${props.id}: ${count()}`}</Text>
      <View testID={`inc-${props.id}`} style={{ width: 20, height: 20 }} onPress={() => count.set(count() + 1)} />
    </View>
  );
}

function describe(node: DockNode): string {
  if (node.type === "tabs") {
    return `[${node.panels.map((p, i) => (i === (node.activeIndex ?? 0) ? `${p}*` : p)).join(" ")}]`;
  }
  const sizes = node.sizes ?? [];
  const children = node.children.map((child, i) => {
    const size = sizes[i];
    return size == null ? describe(child) : `${describe(child)}:${Math.round(size)}`;
  });
  return `${node.axis === "horizontal" ? "h" : "v"}(${children.join(" ")})`;
}

export default function BaseDock() {
  const layout = signal<DockAreaLayout>({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: ["a", "b"] },
        { type: "tabs", panels: ["c"] },
      ],
      sizes: [200, null],
    },
  });
  const removed = signal("none");
  const zoom = signal("none");
  const active = signal<string[]>([]);
  let area: DockAreaRef | undefined;
  return (
    <View style={{ paddingTop: 20 }}>
      <View testID="area" style={{ width: 390, height: 300 }}>
        <DockArea
          ref={r => (area = r)}
          compact={false}
          layout={layout()}
          onLayoutChange={({ layout: next }) => layout.set(next)}
          onPanelRemove={({ panel }) => removed.set(panel)}
          onZoomChange={({ panel }) => zoom.set(panel ?? "out")}
          onPanelActiveChange={({ panel, active: on }) => active.set([...active(), `${panel}${on ? "+" : "-"}`])}
          class="flex-1"
          tabBarClass="flex-row h-[24px]"
          tabClass="w-[60px] selected:bg-[#336699]"
          contentClass="bg-[#eeeeee]"
          dropIndicatorClass="bg-[#ff0000]"
          renderTab={tab => (
            <View testID={`tab-${tab.panel}`}>
              <Text>{`Tab ${tab.panel}${tab.active ? "*" : ""}`}</Text>
            </View>
          )}
          renderPanel={panel => <Counter id={panel.id} />}
          renderDragPreview={tab => <Text>{`Preview ${tab.panel}`}</Text>}
          renderDropIndicator={drop => (
            <View testID="drop">
              <Text>{`Drop ${drop.side ?? "into"}`}</Text>
            </View>
          )}
        />
      </View>
      <Text>{() => `Layout ${describe(layout().center)}`}</Text>
      <Text>{() => `Removed ${removed()}`}</Text>
      <Text>{() => `Zoom ${zoom()}`}</Text>
      <Text>{() => `Active ${active().join(" ")}`}</Text>
      <View style={{ flexDirection: "row" }}>
        <View testID="close-b" style={{ width: 20, height: 20 }} onPress={() => area?.closePanel("b")} />
        <View
          testID="zoom-c"
          style={{ width: 20, height: 20 }}
          onPress={() => area?.groupOf("c").then(group => area?.toggleZoom(group))}
        />
        <View testID="unzoom" style={{ width: 20, height: 20 }} onPress={() => area?.toggleZoom(null)} />
      </View>
    </View>
  );
}
