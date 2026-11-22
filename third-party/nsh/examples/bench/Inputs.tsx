// `nsh test examples/bench/Inputs.tsx --trace` with steps on standard input:
// the input controls' hot paths. A searchable Select of 10 000 items (a
// search keystroke), a TimeField (a digit), a NumberInput (a keystroke) and
// an OtpInput (its caret blinking while focused). Steps and results:
// `docs/dev/performance.md` "Input controls".
import { mount, Text, View } from "nsh";
import { NumberInput, OtpInput, Select, TimeField } from "nsh/base";

const ITEMS = Array.from({ length: 10_000 }, (_, i) => ({ value: `item${i}`, title: `Item ${i}` }));

mount(() => (
  <View style={{ padding: 20, gap: 12 }}>
    <Select
      items={ITEMS}
      searchable
      searchPlaceholder="Search"
      accessibilityLabel="Items"
      trigger={
        <View style={{ width: 200, height: 30 }}>
          <Text>Pick</Text>
        </View>
      }
    />
    <TimeField accessibilityLabel="Time" defaultValue="09:30" style={{ flexDirection: "row", width: 200, height: 30 }} />
    <NumberInput accessibilityLabel="Amount" defaultValue={5} style={{ width: 200, height: 30 }} />
    <OtpInput
      length={6}
      accessibilityLabel="Code"
      style={{ flexDirection: "row", gap: 4 }}
      cellStyle={{ width: 30, height: 40 }}
      caretStyle={{ width: 2, height: 20, backgroundColor: "black" }}
    />
  </View>
));
