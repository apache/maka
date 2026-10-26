// A case of the API's test suite (docs/dev/compatibility.md): `Overlay` of
// `nsh`, its children on top of the root view whatever clips them: placed
// against an anchor (a ref, a point, then a box: an input's caret)
// on the side asked for, flipped
// and kept inside the margin where it does not fit (`placement`, `align`,
// `offset`, `margin`, `onPosition`), a press outside it (`onPressOutside`)
// and Escape or back (`onCancel`). Its script checks each.
import { Overlay, Text, View, type YNode, signal } from "nsh";

function App() {
  const open = signal(true);
  const at = signal<"ref" | "point" | "box">("ref");
  const placed = signal("none");
  const pressed = signal("none");
  let anchor: YNode | undefined;
  return (
    <View style={{ flex: 1, paddingTop: 100, paddingLeft: 40 }}>
      <View style={{ width: 100, height: 30, overflow: "hidden" }}>
        <View ref={anchor} testID="anchor" style={{ width: 60, height: 20 }} />
        <If when={open()}>
          <Overlay
            testID="overlay"
            anchor={
              at() === "point"
                ? { x: 380, y: 2 }
                : at() === "box"
                  ? { origin: { x: 300, y: 50 }, size: { width: 1, height: 20 } }
                  : anchor
            }
            placement="right"
            align="end"
            offset={8}
            margin={4}
            onPosition={(e) => placed.set(`Placed ${e.placement}`)}
            onPressOutside={() => pressed.set("Pressed outside")}
            onCancel={() => open.set(false)}
            style={{ width: 50, height: 10 }}
          >
            <Text>OverlayContent</Text>
          </Overlay>
        </If>
      </View>
      <View testID="point" onPress={() => at.set("point")} style={{ height: 40 }}>
        <Text>At a point</Text>
      </View>
      <View testID="box" onPress={() => at.set("box")} style={{ height: 40 }}>
        <Text>At a box</Text>
      </View>
      <Text>{placed()}</Text>
      <Text>{pressed()}</Text>
    </View>
  );
}

export default App;
