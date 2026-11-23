import { mount, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

// Screen edge pans around a navigation stack, as a drawer opens from the
// left edge: the stack's own back swipe goes first on a pushed page.
function App() {
  const nav = createNavStack<string>(["root"]);
  const left = signal(0);
  const right = signal(0);
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff" }} panActivation={{ edge: "right" }}
      onPanStart={() => right.update((n) => n + 1)}>
      <View style={{ flex: 1, paddingTop: 64 }} panActivation={{ edge: "left" }}
        onPanStart={() => left.update((n) => n + 1)}>
        <Text>{`depth:${nav.routes().length} left:${left()} right:${right()}`}</Text>
        <NavStack state={nav} style={{ flex: 1 }}>
          {(route) => (
            <NavPage title={route} headerVisible={route !== "root"}>
              <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
                <View role="button" onPress={() => nav.push("second")} style={{ height: 60 }}>
                  <Text>Push</Text>
                </View>
              </View>
            </NavPage>
          )}
        </NavStack>
      </View>
      <View testID="left-edge" style={{ position: "absolute", left: 0, top: 300, width: 4, height: 100, pointerEvents: "none" }} />
      <View testID="right-edge" style={{ position: "absolute", right: 0, top: 300, width: 4, height: 100, pointerEvents: "none" }} />
      <View testID="content" style={{ position: "absolute", left: 100, top: 300, width: 4, height: 100, pointerEvents: "none" }} />
    </View>
  );
}

mount(App);
