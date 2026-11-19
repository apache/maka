// One platform transition reaches its target and logical ancestors once,
// in order, without notifying a sibling listener.
import { signal, Text, View } from "nsh";

export default function KeyboardEvents() {
  const route = signal<string[]>([]);
  const hear = (name: string) => route.update((items) => [...items, name]);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View onKeyDown={() => hear("outer-down")} onKeyUp={() => hear("outer-up")}>
        <View
          testID="keyboard-target"
          focusable
          style={{ height: 40 }}
          onKeyDown={() => hear("target-down")}
          onKeyUp={() => hear("target-up")}
        />
        <View
          style={{ height: 40 }}
          onKeyDown={() => hear("sibling-down")}
          onKeyUp={() => hear("sibling-up")}
        />
      </View>
      <Text>{`Key route: ${route().join(" ") || "none"}`}</Text>
    </View>
  );
}
