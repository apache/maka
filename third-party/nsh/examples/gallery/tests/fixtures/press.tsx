import { Image, mount, signal, Text, View } from "nsh";

const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaGj4DwAFhAKAjM1mJgAAAABJRU5ErkJggg==";

function App() {
  const outer = signal(0);
  const inner = signal(0);
  return (
    <View style={{ flex: 1, paddingTop: 100 }}>
      <View onPress={() => outer.set(outer() + 1)} style={{ padding: 20 }}>
        <View activeStyle={{ opacity: 0.5 }} style={{ padding: 20 }}>
          <Text>Styled child</Text>
        </View>
      </View>
      <View onPress={() => outer.set(outer() + 1)} style={{ padding: 20 }}>
        <View onPress={() => inner.set(inner() + 1)} activeStyle={{ opacity: 0.5 }} style={{ padding: 20 }}>
          <Text>Clickable child</Text>
        </View>
      </View>
      <View onPress={() => outer.set(outer() + 1)} style={{ padding: 20 }}>
        <Text activeStyle={{ opacity: 0.5 }} style={{ padding: 20 }}>Styled text</Text>
      </View>
      <View onPress={() => outer.set(outer() + 1)} style={{ padding: 20 }}>
        <Image src={icon} accessibilityLabel="Styled image" activeStyle={{ opacity: 0.5 }} style={{ width: 120, height: 40 }} />
      </View>
      <View onPress={() => outer.set(outer() + 1)} style={{ padding: 20 }}>
        <View android={{ ripple: { color: "#ff0000" } }} style={{ padding: 20 }}>
          <Text>Ripple child</Text>
        </View>
      </View>
      <Text>Outer {outer()}</Text>
      <Text>Inner {inner()}</Text>
    </View>
  );
}

mount(App);
