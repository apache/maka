// A case of the API's test suite (docs/dev/compatibility.md): what the
// platform reports of a finger, the mouse, dragged files and assistive
// technologies: press in and out, hover in, moves over and out, file drags
// entering, leaving and dropping, accessibility actions, and the keyboard
// focus reaching and leaving a view that takes presses. Each handler
// shows what it gets as text. Its script checks
// each.
import { Text, View, signal } from "nsh";

function App() {
  const press = signal("none");
  const hover = signal("none");
  const mouse = signal("none");
  const drop = signal("none");
  const action = signal("none");
  const keyFocus = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="press"
        style={{ height: 40 }}
        onPressDown={() => press.set("in")}
        onPressUp={() => press.set(press() + " out")}
      />
      <Text>Press: {press()}</Text>
      <View style={{ paddingLeft: 20 }}>
        <View
          testID="hover"
          style={{ height: 40 }}
          onMouseMove={(e) => mouse.set(`${e.x},${e.y}`)}
          onHoverIn={() => hover.set("in")}
          onHoverMove={(e) =>
            hover.set(
              `move ${e.position.x},${e.position.y} page ${e.pagePosition.x},${e.pagePosition.y}` +
                `${e.modifiers.alt ? " alt" : ""}${e.modifiers.control ? " ctrl" : ""}` +
                `${e.modifiers.platform ? " meta" : ""}${e.modifiers.shift ? " shift" : ""}`,
            )
          }
          onHoverOut={() => hover.set(hover() + " out")}
        />
      </View>
      <Text>Hover: {hover()}</Text>
      <Text>Mouse: {mouse()}</Text>
      <View
        testID="drop"
        style={{ height: 40 }}
        onFileDragEnter={() => drop.set("enter")}
        onFileDragLeave={() => drop.set(drop() + " leave")}
        onFileDrop={(e) => drop.set(`dropped ${e.uris.length}: ${e.uris.join(" ")}`)}
      />
      <Text>Drop: {drop()}</Text>
      <View
        testID="action"
        accessible
        accessibilityLabel="Counter"
        accessibilityActions={[{ name: "increment", label: "Increment" }, { name: "activate" }]}
        onAccessibilityAction={(e) => action.set(e.actionName)}
        style={{ height: 40 }}
      />
      <Text>Action: {action()}</Text>
      <View
        testID="key-focus"
        style={{ height: 40 }}
        onPress={() => {}}
        onFocus={() => keyFocus.set("focused")}
        onBlur={() => keyFocus.set(keyFocus() + " blurred")}
      />
      <Text>Key focus: {keyFocus()}</Text>
    </View>
  );
}

export default App;
