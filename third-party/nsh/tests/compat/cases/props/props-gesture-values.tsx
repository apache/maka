// A case of the API's test suite (docs/dev/compatibility.md): the animated
// values gestures drive natively, as the platform receives them: a drag's
// translation on both axes (one view) and on one (another), a pinch's
// scale and a two-finger rotation's angle. Each value is told apart by
// the value it starts at. Its script
// checks each.
import { Text, View } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const x = createAnimatedValue(11);
  const y = createAnimatedValue(22);
  const down = createAnimatedValue(33);
  const scale = createAnimatedValue(1.5);
  const angle = createAnimatedValue(45);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="card" pan={{ x, y }} style={{ height: 60, transform: [{ translateX: x }, { translateY: y }] }}>
        <Text>Card</Text>
      </View>
      <View testID="sheet" pan={{ y: down }} style={{ height: 60, transform: [{ translateY: down }] }}>
        <Text>Sheet</Text>
      </View>
      <View
        testID="photo"
        pinch={{ scale }}
        rotation={{ angle }}
        style={{ height: 60, transform: [{ scale }, { rotate: angle }] }}
      >
        <Text>Photo</Text>
      </View>
    </View>
  );
}

export default App;
