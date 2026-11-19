// A long menu in a short window (menu-room.test.tsx), drawn with the
// gallery's menu look (`menuPopup`: the surface on the popup's own box):
// thirty zones under a trigger near the window's top, more than the room
// below it holds, and a text saying whether the popup kept to that room
// and which zone was chosen.
import { mount, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { menuItemLabel, menuItemLook, menuPopup } from "../../ui";

const ZONES = Array.from({ length: 30 }, (_, i) => `Zone ${i + 1}`);

function App() {
  const chose = signal("none");
  const held = signal(false);
  return (
    <View style={{ flex: 1, padding: 16, gap: 8, alignItems: "flex-start" }}>
      <Text>{`chose: ${chose()}`}</Text>
      <Text>{`held: ${held()}`}</Text>
      <Menu
        offset={4}
        margin={8}
        {...menuPopup()}
        onPosition={({ bounds, available }) => held.set(bounds.size.height <= available.height + 0.5)}
        trigger={
          <View role="button" style={{ padding: 8 }}>
            <Text>Time zone</Text>
          </View>
        }
      >
        <Each of={ZONES}>
          {(z) => (
            <MenuItem onSelect={() => chose.set(z())} {...menuItemLook()}>
              <Text style={menuItemLabel()}>{z()}</Text>
            </MenuItem>
          )}
        </Each>
      </Menu>
    </View>
  );
}

mount(App);
