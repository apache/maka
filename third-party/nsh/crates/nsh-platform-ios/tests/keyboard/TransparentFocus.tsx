import { Menu, MenuItem } from "nsh/base";
import { mount, signal, Text, View, type ViewRef } from "nsh";

/** Stops under a transparent view (#3027): a menu whose popup comes in
 * from `opacity: 0`, its trigger the first Tab stop; a stop in a panel kept
 * at `opacity: 0`, a stop after it, and a control that focuses the hidden
 * stop with its ref. */
function App() {
  let veiled!: ViewRef;
  const focus = signal("none");
  const chose = signal("none");
  const stop = { height: 32, backgroundColor: "#eeeeee", margin: 4 };
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`focus:${focus()}`}</Text>
      <Text>{`chose:${chose()}`}</Text>
      <Menu
        popupStyle={{
          backgroundColor: "#f3f4f6",
          padding: 6,
          minWidth: 200,
          transitionProperty: "opacity",
          transitionDuration: 150,
        }}
        popupStartingStyle={{ opacity: 0 }}
        trigger={
          <View testID="trigger" style={stop}>
            <Text>menu</Text>
          </View>
        }
      >
        <MenuItem onSelect={() => chose.set("one")}>
          <Text>one</Text>
        </MenuItem>
        <MenuItem onSelect={() => chose.set("two")}>
          <Text>two</Text>
        </MenuItem>
      </Menu>
      <View style={{ opacity: 0 }}>
        <View
          ref={(value) => {
            veiled = value;
          }}
          testID="veiled"
          focusable
          onFocus={() => focus.set("veiled")}
          onBlur={() => focus.set("none")}
          style={stop}
        >
          <Text>veiled</Text>
        </View>
      </View>
      <View
        testID="after"
        focusable
        onPress={() => {}}
        onFocus={() => focus.set("after")}
        onBlur={() => focus.set("none")}
        style={stop}
      >
        <Text>after</Text>
      </View>
      <View testID="focusVeiled" focusable={false} onPress={() => veiled.focus()} style={stop}>
        <Text>focus veiled</Text>
      </View>
    </View>
  );
}

mount(App);
