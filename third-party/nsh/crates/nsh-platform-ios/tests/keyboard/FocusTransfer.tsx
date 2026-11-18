import { Input } from "nsh/base";
import { mount, signal, Text, View, type ViewRef } from "nsh";

/** A first Tab stop, a view that can be blurred or removed, and a native
 * input: what the root does when no responder is left, and what it must
 * not take from an input. */
function App() {
  let pad!: ViewRef;
  const focus = signal("none");
  const text = signal("");
  const visible = signal(true);
  const row = { height: 32, backgroundColor: "#eeeeee", margin: 4 };
  return (
    <View style={{ flex: 1, paddingTop: 64, backgroundColor: "#ffffff" }}>
      <Text>{`focus:${focus()}`}</Text>
      <Text>{`input:${text()}`}</Text>
      <View
        testID="first"
        focusable
        onPress={() => {}}
        onFocus={() => focus.set("first")}
        style={row}
      >
        <Text>first</Text>
      </View>
      {visible() ? (
        <View
          ref={(value) => {
            pad = value;
          }}
          testID="pad"
          focusable
          onPress={() => {}}
          onFocus={() => focus.set("pad")}
          onBlur={() => focus.set("none")}
          style={row}
        >
          <Text>pad</Text>
        </View>
      ) : null}
      <View
        testID="blurPad"
        focusable={false}
        onPress={() => pad.blur()}
        style={row}
      >
        <Text>blur pad</Text>
      </View>
      <View
        testID="removePad"
        focusable={false}
        onPress={() => visible.set(false)}
        style={row}
      >
        <Text>remove pad</Text>
      </View>
      <Input
        testID="field"
        style={{ height: 44 }}
        onFocus={() => focus.set("field")}
        onBlur={() => focus.set("none")}
        onChange={({ value }) => text.set(value)}
      />
    </View>
  );
}

mount(App);
