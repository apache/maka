// A case of the API's test suite (docs/dev/compatibility.md): the states'
// looks of `nsh/base`'s popups on a desktop. A `Popover`, a `Menu` with a
// `Submenu`, a `ContextMenu` and a `Tooltip` are made with their starting
// looks (classes: the opacity; styles: the background), take their own look
// from their first frame on, and once closed stay with their ending looks
// through their transitions' 300 ms, `onClose` after. The popover and the
// menu say the side they went on (`onPosition`). Its script checks each.
import { Text, View, signal } from "nsh";
import { ContextMenu, Menu, MenuItem, Popover, Submenu, Tooltip } from "nsh/base";

function App() {
  const life = signal("Life: none");
  const side = signal("Side: none");
  const tip = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 100, paddingLeft: 20, gap: 8 }}>
      <Popover
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onOpen={() => life.set("Life: popover open")}
        onClose={() => life.set("Life: popover closed")}
        onPosition={({ placement, bounds }) => side.set(`Side: popover ${placement} ${bounds.size.height}`)}
        trigger={<View style={{ height: 30, width: 100 }}><Text>PopTrigger</Text></View>}
      >
        <Text style={{ height: 40 }}>PopBody</Text>
      </Popover>
      <Menu
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onClose={() => life.set("Life: menu closed")}
        onPosition={({ placement }) => side.set(`Side: menu ${placement}`)}
        trigger={<View style={{ height: 30, width: 100 }}><Text>MenuTrigger</Text></View>}
      >
        <MenuItem><Text>MenuNew</Text></MenuItem>
        <Submenu trigger={<View><Text>MenuShare</Text></View>}>
          <MenuItem><Text>MenuMail</Text></MenuItem>
        </Submenu>
      </Menu>
      <ContextMenu
        popupClass="transition-all duration-300"
        popupStartingClass="opacity-0"
        popupStartingStyle={{ backgroundColor: "#ff0000" }}
        popupEndingClass="opacity-50"
        popupEndingStyle={{ backgroundColor: "#0000ff" }}
        onClose={() => life.set("Life: context closed")}
        onPosition={({ placement }) => side.set(`Side: context ${placement}`)}
        trigger={<View style={{ height: 30 }}><Text>LooksArea</Text></View>}
      >
        <MenuItem><Text>CtxCopy</Text></MenuItem>
      </ContextMenu>
      <View
        onPress={() => tip.set(!tip())}
        style={{ height: 30, width: 100 }}
        tooltip={
          <Tooltip
            open={tip()}
            class="transition-all duration-300"
            startingClass="opacity-0"
            startingStyle={{ backgroundColor: "#ff0000" }}
            endingClass="opacity-50"
            endingStyle={{ backgroundColor: "#0000ff" }}
            onClose={() => life.set("Life: tooltip closed")}
          >
            <Text>TipBody</Text>
          </Tooltip>
        }
      >
        <Text>TipToggle</Text>
      </View>
      <Text>{life()}</Text>
      <Text>{side()}</Text>
    </View>
  );
}

export default App;
