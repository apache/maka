import { mount, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const VALUE = "test1 test2 test3";

function App() {
  const selected = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: 24, gap: 16 }}>
      {/* Hears touches so that a test's long press has a view to hold. */}
      <View testID="key" onTouchStart={() => {}}>
        <Input
          readonly
          multiline
          value={VALUE}
          onSelectionChange={({ start, end }) => selected.set(VALUE.slice(start, end))}
          style={{ fontSize: 22 }}
        />
      </View>
      <Text>{`selected: ${selected() || "nothing"}`}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
    </View>
  );
}

mount(App);
