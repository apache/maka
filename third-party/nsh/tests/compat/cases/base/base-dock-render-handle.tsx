// `DockArea`'s `renderHandle`: what is inside the indicator of the handle
// between a split's groups, given its place, its axis and its state.
import { Text, View } from "nsh";
import { DockArea } from "nsh/base";

export default function BaseDockRenderHandle() {
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 390, height: 200 }}>
        <DockArea
          compact={false}
          defaultLayout={{
            center: {
              type: "split",
              axis: "horizontal",
              children: [
                { type: "tabs", panels: ["a"] },
                { type: "tabs", panels: ["b"] },
              ],
            },
          }}
          class="flex-1"
          tabBarClass="flex-row h-[24px]"
          renderTab={tab => <Text>{`Tab ${tab.panel}`}</Text>}
          renderPanel={panel => <Text>{`Panel ${panel.id}`}</Text>}
          renderHandle={handle => <Text>{`Grip ${handle.index} ${handle.axis} ${handle.state}`}</Text>}
        />
      </View>
    </View>
  );
}
