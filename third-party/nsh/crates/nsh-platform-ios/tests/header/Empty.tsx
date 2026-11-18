// Checked by eye with `nsh test --target ios` and steps on stdin: while the
// trailing slot's view is empty the bar shows no button there (iOS 26+ drew
// an empty Liquid Glass button), and `Edit` comes and goes with the toggle.
import { mount, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";

/** A page whose header's trailing slot shows a button only while `shown`:
 * the slot's view stays, empty, when it hides. */
function App() {
  const nav = createNavStack<"root">(["root"]);
  const shown = signal(false);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {() => (
        <NavPage
          title="Empty slot"
          headerRight={<View style={{ flexDirection: "row" }}>{shown() ? <Text testID="edit">Edit</Text> : null}</View>}
        >
          <View style={{ flex: 1, padding: 16, gap: 12 }}>
            <Text>{shown() ? "shown" : "hidden"}</Text>
            <View testID="toggle" role="button" onPress={() => shown.set(!shown())} style={{ padding: 8 }}>
              <Text>Toggle</Text>
            </View>
          </View>
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
