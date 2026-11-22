// A case of the API's test suite (docs/dev/compatibility.md): the device
// variants of classes, which the core applies without JS. In a terminal
// the primary pointer is fine (`pointer-fine:`, not `pointer-coarse:`) and
// `terminal:` applies.
import { View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="device"
        class="h-8 bg-[#cccccc] pointer-fine:bg-[#00ff00] pointer-coarse:opacity-25 terminal:border-2"
      />
    </View>
  );
}

export default App;
