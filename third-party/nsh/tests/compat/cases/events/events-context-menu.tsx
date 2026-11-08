// A case of the API's test suite (docs/dev/compatibility.md): what the
// platform reports when a context menu is asked for (the secondary
// button, a long press, the keyboard): `onContextMenu`'s positions,
// modifier keys and `pointerType` (`null` without a pointer), heard by the
// nearest listener around the view under the pointer. The handler shows
// what it gets as text. Its script checks each.
import { Text, View, signal } from "nsh";

function App() {
  const menu = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View style={{ paddingLeft: 20 }}>
        <View
          testID="menu"
          style={{ height: 60, paddingTop: 10 }}
          onContextMenu={(e) =>
            menu.set(
              `at ${e.position.x},${e.position.y} page ${e.pagePosition.x},${e.pagePosition.y}` +
                `${e.modifiers.alt ? " alt" : ""}${e.modifiers.control ? " ctrl" : ""}` +
                `${e.modifiers.platform ? " meta" : ""}${e.modifiers.shift ? " shift" : ""}` +
                ` by ${e.pointerType ?? "keyboard"}`,
            )
          }
        >
          <View testID="inner" style={{ height: 20 }} />
        </View>
      </View>
      <Text>Menu: {menu()}</Text>
    </View>
  );
}

export default App;
