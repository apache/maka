// A case of the API's test suite (docs/dev/compatibility.md): the gestures
// the platform recognizes on a view: a drag (pan) starting and ending with
// its translation and velocity, a pinch with its scale and a two-finger
// rotation with its angle, each with its velocity. Each handler shows what
// it gets as text. Its script checks
// each.
import { Text, View, signal } from "nsh";

type Pan = { translation: { x: number; y: number }; velocity: { x: number; y: number } };

function pan(e: Pan): string {
  return `${e.translation.x},${e.translation.y} v ${e.velocity.x},${e.velocity.y}`;
}

function App() {
  const drag = signal("none");
  const cancelled = signal(false);
  const pinch = signal("none");
  const rotation = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="drag"
        style={{ height: 40 }}
        onPanStart={(e) => drag.set(`start ${pan(e)}`)}
        onPanEnd={(e) => { drag.set(`${drag()}; end ${pan(e)}`); cancelled.set(e.cancelled ?? false); }}
      />
      <Text>Pan: {drag()}</Text>
      <Text>Cancelled: {String(cancelled())}</Text>
      <View
        testID="pinch"
        style={{ height: 40 }}
        onPinchStart={(e) => pinch.set(`start ${e.scale} v ${e.velocity}`)}
        onPinchEnd={(e) => pinch.set(`${pinch()}; end ${e.scale} v ${e.velocity}`)}
      />
      <Text>Pinch: {pinch()}</Text>
      <View
        testID="rotation"
        style={{ height: 40 }}
        onRotationStart={(e) => rotation.set(`start ${e.rotation} v ${e.velocity}`)}
        onRotationEnd={(e) => rotation.set(`${rotation()}; end ${e.rotation} v ${e.velocity}`)}
      />
      <Text>Rotation: {rotation()}</Text>
    </View>
  );
}

export default App;
