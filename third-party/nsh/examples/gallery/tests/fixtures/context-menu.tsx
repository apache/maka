import { mount, signal, Text, View } from "nsh";
import { ContextMenu, MenuItem } from "nsh/base";

function App() {
  const tapped = signal("none");
  const chose = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 100 }}>
      <ContextMenu
        trigger={
          <View role="button" onPress={() => tapped.set("solo")} style={{ height: 60 }}>
            <Text>solo</Text>
          </View>
        }
      >
        <MenuItem onSelect={() => chose.set("menu-solo")}>
          <Text>menu-solo</Text>
        </MenuItem>
      </ContextMenu>
      <Text>{`tapped: ${tapped()}`}</Text>
      <Text>{`chose: ${chose()}`}</Text>
    </View>
  );
}

mount(App);
