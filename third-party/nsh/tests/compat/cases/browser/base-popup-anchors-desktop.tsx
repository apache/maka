// A case of the API's test suite (docs/dev/compatibility.md): on a desktop,
// `nsh/base`'s popups are placed against their trigger's own box, not the
// box around what is inside it. A `Popover` whose trigger its column
// stretches to 200 points around a 20-point box, and a `Menu` whose icon
// trigger is 40 points wide by its `minWidth` around a 16-point icon. Its
// script checks where each popup goes.
import { Text, View } from "nsh";
import { Menu, MenuItem, Popover } from "nsh/base";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 300, paddingLeft: 20, gap: 8 }}>
      <View style={{ width: 200 }}>
        <Popover
          offset={4}
          popupStyle={{ width: 40, height: 20 }}
          trigger={
            <View testID="stretched-trigger" style={{ flexDirection: "row", alignItems: "center", height: 30, paddingHorizontal: 10 }}>
              <View style={{ width: 20, height: 10 }} />
            </View>
          }
        >
          <Text>StretchBody</Text>
        </Popover>
      </View>
      <Menu
        offset={4}
        popupStyle={{ width: 90, height: 40 }}
        trigger={
          <View testID="icon-trigger" style={{ alignSelf: "flex-start", minWidth: 40, height: 30, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 16, height: 16 }} />
          </View>
        }
      >
        <MenuItem><Text>IconItem</Text></MenuItem>
      </Menu>
    </View>
  );
}

export default App;
