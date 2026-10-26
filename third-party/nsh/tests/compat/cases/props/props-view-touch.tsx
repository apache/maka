// A case of the API's test suite (docs/dev/compatibility.md): the touch
// props of every element as the platform receives them: `pointerEvents`,
// `hitSlop` (a number for every side, or some sides), `delayLongPress`,
// `panActivation` and `focusable` (`false` on a pressable, `true` on a view
// that takes no presses). Its script
// checks each.
import { View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="none" pointerEvents="none" style={{ height: 20 }} />
      <View testID="box-none" pointerEvents="box-none" style={{ height: 20 }} />
      <View testID="slop" hitSlop={10} onPress={() => {}} style={{ height: 20 }} />
      <View
        testID="slop-sides"
        hitSlop={{ top: 4, left: 2 }}
        onPress={() => {}}
        style={{ height: 20 }}
      />
      <View testID="long" delayLongPress={800} onLongPress={() => {}} style={{ height: 20 }} />
      <View
        testID="pan"
        panActivation={{ activeOffsetX: 20, failOffsetY: 10 }}
        onTouchStart={() => {}}
        style={{ height: 20 }}
      />
      <View testID="unfocusable" focusable={false} onPress={() => {}} style={{ height: 20 }} />
      <View testID="stop" focusable style={{ height: 20 }} />
      <View testID="plain" onPress={() => {}} style={{ height: 20 }} />
    </View>
  );
}

export default App;
