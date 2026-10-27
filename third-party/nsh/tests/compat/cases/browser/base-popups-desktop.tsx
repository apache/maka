// A case of the API's test suite (docs/dev/compatibility.md): the popups of
// `nsh/base` on a desktop: a `Popover` that a press outside leaves open
// (`closeOnPressOutside`), a `Menu` as a popup on a side of its trigger
// (its side, alignment, gap and margin), a `ContextMenu` the secondary
// button opens where the pointer is (its gap and margin), a `Tooltip` (an element's
// `tooltip`) shown after the pointer rests on its trigger (`delay`) and hidden when it leaves,
// and an element's `tooltip` that is a plain element. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { ContextMenu, Menu, MenuItem, Popover, Tooltip } from "nsh/base";

function App() {
  const log = signal("Log: none");
  const lifecycle = signal("Tip: none");
  return (
    <View style={{ flex: 1, paddingTop: 300, paddingLeft: 20, gap: 8 }}>
      <Text>{log()}</Text>
      <Popover
        defaultOpen
        closeOnPressOutside={false}
        onOpenChange={(open, reason) => log.set(`Log: popover ${open} ${reason}`)}
        trigger={<View style={{ height: 30, width: 100 }}><Text>StayTrigger</Text></View>}
      >
        <Text>StayBody</Text>
      </Popover>
      <View onPress={() => {}} style={{ height: 30 }}><Text>Elsewhere</Text></View>
      <Menu
        placement="right"
        align="end"
        offset={7}
        margin={5}
        style={{ width: 100 }}
        popupStyle={{ width: 90, height: 600 }}
        trigger={<View style={{ height: 30 }}><Text>DeskMenu</Text></View>}
      >
        <MenuItem><Text>DeskItem</Text></MenuItem>
      </Menu>
      <ContextMenu
        offset={3}
        margin={9}
        popupStyle={{ width: 90, height: 40 }}
        trigger={<View style={{ height: 30 }}><Text>RightClickArea</Text></View>}
      >
        <MenuItem><Text>DeskCopy</Text></MenuItem>
      </ContextMenu>
      <View
        style={{ height: 30 }}
        tooltip={
          <Tooltip
            delay={2000}
            onOpenChange={(open, reason) => log.set(`Log: tooltip ${open} ${reason}`)}
            onOpen={() => lifecycle.set("Tip: open")}
            onClose={() => lifecycle.set("Tip: closed")}
          >
            <Text>SlowTip</Text>
          </Tooltip>
        }
      >
        <Text>SlowTrigger</Text>
      </View>
      <Text>{lifecycle()}</Text>
      <View testID="prop-tip" tooltip={<Text>PropTip</Text>} style={{ height: 30, width: 100 }}>
        <Text>PropTrigger</Text>
      </View>
      <View tooltip={<Text>ElementTip</Text>} style={{ height: 30 }}>
        <Text>ElementTrigger</Text>
      </View>
    </View>
  );
}

export default App;
