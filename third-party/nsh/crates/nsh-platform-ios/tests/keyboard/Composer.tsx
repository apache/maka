import { Button, Input, Menu, MenuItem } from "nsh/base";
import { keyboardFrame, mount, signal, Text, View } from "nsh";

/** A composer at the bottom of the page, lifted by the software keyboard:
 * its input, a focusable button and a menu's trigger beside it. On a phone
 * the menu is a sheet that stands above the keyboard, its panel padded by
 * the safe area as an app's is. */
function App() {
  const presses = signal(0);
  const picked = signal(0);
  const focus = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64, paddingBottom: "env(keyboard-inset-height)", backgroundColor: "#ffffff" }}>
      <Text>{keyboardFrame().height > 0 ? "keyboard:up" : "keyboard:down"}</Text>
      <Text>{`focus:${focus()}`}</Text>
      <Text>{`presses:${presses()}`}</Text>
      <Text>{`picked:${picked()}`}</Text>
      <View style={{ flex: 1 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}>
        <Input
          testID="message"
          placeholder="Message"
          onFocus={() => focus.set("message")}
          onBlur={() => focus.set("none")}
          style={{ flex: 1, height: 40 }}
        />
        <Button testID="plus" accessibilityLabel="Plus" onPress={() => presses.set(presses() + 1)} style={{ padding: 8 }}>
          <Text>Plus</Text>
        </Button>
        <Menu
          popupStyle={{ backgroundColor: "#ffffff", paddingBottom: "env(safe-area-inset-bottom)" }}
          trigger={
            <Button testID="attach" accessibilityLabel="Attach" style={{ padding: 8 }}>
              <Text>Attach</Text>
            </Button>
          }
        >
          <MenuItem onSelect={() => picked.set(picked() + 1)}>
            <Text>Photo</Text>
          </MenuItem>
        </Menu>
      </View>
    </View>
  );
}

mount(App);
