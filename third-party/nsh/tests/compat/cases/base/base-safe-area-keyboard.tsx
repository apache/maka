// A case of the API's test suite (docs/dev/compatibility.md): the safe
// areas and the software keyboard of `nsh/base`. `safeArea()` and
// `safeAreaInsets()` at the root (the surface's, none headless), inside a
// `NavPage` and inside a `Dialog` (theirs, as the platform reports them);
// views padded by them through `env(safe-area-inset-*)` on the edges they
// name, on top of their own padding (`calc`); `keyboardFrame()` (no
// keyboard headless), `Keyboard.dismiss` and views padded (or given a
// bottom margin) by `env(keyboard-inset-height)`, which makes no room while
// no keyboard shows, with an offset added only while one shows. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { Button, Dialog, type Edges, NavPage, NavStack, createNavStack } from "nsh/base";
import { Keyboard, keyboardFrame, safeArea, safeAreaInsets } from "nsh";

// The keyboard's height plus `offset` while a keyboard shows, nothing
// otherwise.
const keyboardRoom = (offset: number) =>
  keyboardFrame().height > 0 ? `calc(env(keyboard-inset-height) + ${offset}px)` : "env(keyboard-inset-height)";

const show = (i: Edges) => `${i.top} ${i.right} ${i.bottom} ${i.left}`;

function Here(props: { name: string }) {
  const insets = safeAreaInsets();
  return <Text>{`${props.name} insets: ${show(insets())}`}</Text>;
}

const nav = createNavStack(["page"]);

function App() {
  const dismissed = signal("not called");
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Safe area: ${show(safeArea())}`}</Text>
      <Here name="Root" />
      <Text>{`Keyboard: ${keyboardFrame().height}, duration a ${typeof keyboardFrame().duration}`}</Text>
      <Text>{`Dismiss: ${dismissed()}`}</Text>
      <Button
        onPress={() => {
          Keyboard.dismiss();
          dismissed.set("called");
        }}
      >
        <Text>Dismiss the keyboard</Text>
      </Button>
      <View testID="root-safe" style={{ height: 40, paddingTop: "calc(env(safe-area-inset-top) + 2px)", paddingRight: "calc(env(safe-area-inset-right) + 2px)", paddingBottom: "calc(env(safe-area-inset-bottom) + 2px)", paddingLeft: "calc(env(safe-area-inset-left) + 2px)" }}>
        <View testID="root-inner" style={{ flex: 1 }} />
      </View>
      <View testID="avoid-padding" style={{ height: 30, paddingBottom: keyboardRoom(20) }}>
        <View testID="avoid-padding-inner" style={{ flex: 1 }} />
      </View>
      <View testID="avoid-height" style={{ height: 30, marginBottom: keyboardRoom(20) }}>
        <View testID="avoid-height-inner" style={{ flex: 1 }} />
      </View>
      <View testID="avoid-off" style={{ height: 30 }}>
        <View testID="avoid-off-inner" style={{ flex: 1 }} />
      </View>
      <NavStack state={nav} style={{ height: 300 }}>
        {() => (
          <NavPage title="Insets">
            <View style={{ flex: 1 }}>
              <Here name="Page" />
              <View testID="page-all" style={{ height: 100, paddingTop: "calc(env(safe-area-inset-top) + 2px)", paddingRight: "calc(env(safe-area-inset-right) + 2px)", paddingBottom: "calc(env(safe-area-inset-bottom) + 2px)", paddingLeft: "calc(env(safe-area-inset-left) + 2px)" }}>
                <View testID="page-all-inner" style={{ flex: 1 }} />
              </View>
              <View testID="page-vertical" style={{ height: 100, paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
                <View testID="page-vertical-inner" style={{ flex: 1 }} />
              </View>
              <View testID="page-left" style={{ height: 20, paddingLeft: "env(safe-area-inset-left)" }}>
                <View testID="page-left-inner" style={{ flex: 1 }} />
              </View>
            </View>
          </NavPage>
        )}
      </NavStack>
      <Dialog>
        <Here name="Dialog" />
        <View testID="dialog-safe" style={{ height: 100, paddingRight: "env(safe-area-inset-right)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          <View testID="dialog-inner" style={{ flex: 1 }} />
        </View>
      </Dialog>
    </View>
  );
}

export default App;
