// A case of the API's test suite (docs/dev/compatibility.md):
// `nsh/picker` on the headless runtime, where no system picker answers:
// options out of range throw in the call, and a pick is a promise (pending
// there; a picker the user cancels resolves it with no images). Its script
// checks each.
import { Text, View, signal } from "nsh";
import { Picker, type PickedImage } from "nsh/picker";

function App() {
  const result = signal("not picked");
  const thrown = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Picked: ${result()}`}</Text>
      <Text>{`Thrown: ${thrown()}`}</Text>
      <View
        testID="pick"
        onPress={() => {
          try {
            Picker.pickImages({ multiple: true, limit: 0 });
          } catch (e) {
            thrown.set((e as Error).name);
          }
          const pick = Picker.pickImages({ multiple: true, limit: 4, maxDimension: 2048, quality: 0.8, format: "compatible" });
          result.set(typeof pick.then === "function" ? "pending" : "not a promise");
          pick.then(
            (images: PickedImage[]) => result.set(`${images.length} images`),
            (e) => result.set(`failed: ${e}`),
          );
        }}
      >
        <Text>Pick</Text>
      </View>
    </View>
  );
}

export default App;
