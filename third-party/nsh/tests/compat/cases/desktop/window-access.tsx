// A case of the API's test suite (docs/dev/compatibility.md): the `windows`
// capability, checked natively. This app grants four kinds and four open
// windows at once, its first window included: an overlay (a kind it does not
// grant, and never granted unless declared) and a window beyond the fourth
// reject with `ERR_ACCESS_DENIED` (`permission: "windows"`, `resource`: the
// window's id); `currentWindow()` outside a component (a handler) throws a
// `TypeError`, while `titleBar()` and `windowState()` safely fall back to the
// open `"main"` window (and an effect reading them while a window closes does
// not throw).
import { Text, View, effect, signal } from "nsh";
import { Window, currentWindow, titleBar, windowState } from "nsh/desktop";

const describe = (e: unknown) => {
  const error = e as { name?: string; code?: string; permission?: string; resource?: string };
  return error.code ? `${error.code} ${error.permission} ${error.resource}` : String(error.name);
};

function App() {
  const result = signal("not called");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Result: ${result()}`}</Text>
      <View
        testID="overlay"
        onPress={() => {
          try {
            Window.open(() => <Text>Overlay</Text>, { id: "hud", kind: "overlay" });
            result.set("overlay opened");
          } catch (e) {
            result.set(`overlay ${describe(e)}`);
          }
        }}
      >
        <Text>Overlay</Text>
      </View>
      <View
        testID="many"
        onPress={() => {
          const ids = ["a", "b", "c", "d"];
          let refused = "none";
          for (const id of ids) {
            try {
              Window.open(() => <Text>{id}</Text>, { id, kind: "popup" });
            } catch (e) {
              refused = describe(e);
            }
          }
          result.set(`fourth ${refused}`);
        }}
      >
        <Text>Many</Text>
      </View>
      <View
        testID="cleanup"
        onPress={() => {
          for (const id of ["a", "b", "c"]) Window.get(id)?.close();
          result.set("closed");
        }}
      >
        <Text>Cleanup</Text>
      </View>
      <View
        testID="outside"
        onPress={() => {
          let current = "returned";
          try {
            currentWindow();
          } catch (e) {
            current = describe(e);
          }
          const bar = titleBar();
          const state = windowState();
          const transient = Window.open(() => {
            effect(() => {
              void windowState();
              void titleBar();
            });
            return <Text>Transient</Text>;
          }, { id: "transient", kind: "popup" });
          transient.close();
          Promise.resolve().then(() => {
            const asyncBar = titleBar();
            const asyncState = windowState();
            result.set(
              `outside ${current}, bar ${bar.height} ${asyncBar.height}, state ${state} ${asyncState}`,
            );
          });
        }}
      >
        <Text>Outside</Text>
      </View>
    </View>
  );
}

export default App;
