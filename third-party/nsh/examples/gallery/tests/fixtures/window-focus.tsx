// A panel whose first view is a field (window-focus.test.tsx): nothing in
// a window is focused until the user (or the app) focuses it, as in the
// main window.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Window } from "nsh/desktop";

const inspectorOpen = signal(false);
const focus = signal("none");

function Inspector() {
  return (
    <View style={{ flex: 1, padding: 12, gap: 8 }}>
      <Input
        testID="title"
        accessibilityLabel="Title"
        value="Untitled"
        onFocus={() => focus.set("title")}
        onBlur={() => focus.set("none")}
        style={{ height: 28 }}
      />
      {/* A press here lands on the panel, not on a focusable view. */}
      <View testID="body" onPress={() => {}} style={{ flex: 1 }}>
        <Text>Inspector body</Text>
      </View>
    </View>
  );
}

function App() {
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, alignItems: "flex-end" }}>
      <View role="button" onPress={() => inspectorOpen.set(true)}>
        <Text>Open inspector</Text>
      </View>
      <Text>{`Field focus: ${focus()}`}</Text>
      <Window
        id="inspector"
        kind="panel"
        parent="main"
        title="Inspector"
        open={inspectorOpen()}
        onOpenChange={({ open }) => inspectorOpen.set(open)}
        defaultSize={{ width: 240, height: 160 }}
      >
        <Inspector />
      </Window>
    </View>
  );
}

mount(App);
