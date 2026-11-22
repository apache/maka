import { Text, View, mount, signal } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: "#123456", fontWeight: "bold", fontStyle: "italic", textDecorationLine: "underline" }}>界A</Text>
      <View testID="increment" onPress={() => count.set(count() + 1)} style={{ width: 80, height: 32 }}>
        <Text>Count {count()}</Text>
      </View>
    </View>
  );
}

mount(App);
