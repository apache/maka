// A case of the API's test suite (docs/dev/compatibility.md): `Progress`
// of `nsh/base`, a progress bar with no look of its own: its role, range
// and value as screen readers get them (`accessibilityLabel`), the value
// the app owns (`value`, held to 0 to 100), none while `indeterminate`,
// and the app's look of its track and indicator (`trackClass`,
// `trackStyle`, `indicatorClass`, `indicatorStyle`). The parts' heights
// and margins make the progress bar's height, which is how its script
// sees them.
import { Text, View, signal } from "nsh";
import { Progress } from "nsh/base";

function App() {
  const value = signal(40);
  const waiting = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Progress
        testID="upload"
        value={value()}
        indeterminate={waiting()}
        accessibilityLabel="Uploading"
        class="flex-row items-start gap-[8px]"
        trackClass="w-[100px] p-[3px]"
        trackStyle={{ marginBottom: 6 }}
        indicatorClass={waiting() ? "h-[30px] w-[20px]" : "h-[30px]"}
        indicatorStyle={{ marginTop: 4 }}
      >
        <Text>{`${value()}%`}</Text>
      </Progress>
      <View testID="more" onPress={() => value.set(value() + 80)} style={{ height: 20 }} />
      <View testID="wait" onPress={() => waiting.set(!waiting())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
