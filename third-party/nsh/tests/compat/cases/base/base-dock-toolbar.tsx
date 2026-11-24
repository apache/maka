// `DockArea`'s `renderToolbar`: the toolbar at the end of a tab group's
// tab bar, given its displayed tab.
import { Text, View } from "nsh";
import { DockArea } from "nsh/base";

export default function BaseDockToolbar() {
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
                { type: "tabs", panels: ["a", "b"] },
                { type: "tabs", panels: ["c"] },
              ],
            },
          }}
          class="flex-1"
          tabBarClass="flex-row h-[24px]"
          renderTab={tab => <Text testID={`toolbar-tab-${tab.panel}`}>{`Tab ${tab.panel}`}</Text>}
          renderPanel={panel => <Text>{`Panel ${panel.id}`}</Text>}
          renderToolbar={tab => <Text>{`Toolbar ${tab.panel} of ${tab.index}`}</Text>}
        />
      </View>
    </View>
  );
}
