// A case of the API's test suite (docs/dev/compatibility.md): a view
// clipped to a rounded rectangle inside it (`clipPath`, CSS's
// `clip-path: inset()`) as the platform receives it: one to four edges,
// lengths and percentages, corners after `round`, `none`, a change the app
// makes, and its transition by name.
import { Text, View, signal } from "nsh";

function PaintClipPath() {
  const open = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Clip path</Text>
      <View testID="open" onPress={() => open.set(true)}>
        <Text>Open</Text>
      </View>
      <View testID="one" style={{ width: 40, height: 40, clipPath: "inset(4px)" }} />
      <View testID="two" style={{ width: 40, height: 40, clipPath: "inset(10% 2px)" }} />
      <View testID="four" style={{ width: 40, height: 40, clipPath: "inset(1px 2px 3px 4px round 6px)" }} />
      <View testID="corners" style={{ width: 40, height: 40, clipPath: "inset(0 round 2px 4px 6px 8px)" }} />
      <View testID="none" style={{ width: 40, height: 40, clipPath: "none" }} />
      <View testID="unclipped" style={{ width: 40, height: 40 }} />
      <View
        testID="panel"
        style={{
          width: 40,
          height: 40,
          clipPath: open() ? "inset(0 round 12px)" : "inset(0 0 100% 100% round 12px)",
          transitionProperty: "clip-path",
          transitionDuration: 420,
        }}
      />
    </View>
  );
}

export default PaintClipPath;
