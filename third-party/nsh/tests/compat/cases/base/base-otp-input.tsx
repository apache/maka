// A case of the API's test suite (docs/dev/compatibility.md): `OtpInput`
// of `nsh/base`, a one-time code with no look of its own: one field over
// its cells for the keyboard and screen readers (`accessibilityLabel`),
// digits only up to `length`, the code the app owns (`value`, `onChange`)
// or its own (`defaultValue`), `onComplete` once full, the focus
// (`onFocus`, `onBlur`), `masked` and `disabled`, and the app's look of
// its cells, groups and caret (`groups`, `cellClass`, `cellStyle`,
// `groupClass`, `groupStyle`, `caretClass`, `caretStyle`). The parts'
// heights, paddings and margins make the input's height, which is how its
// script sees them.
import { Text, View, signal } from "nsh";
import { OtpInput } from "nsh/base";

function App() {
  const code = signal("");
  const done = signal("");
  const focused = signal("no");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <OtpInput
        testID="otp"
        length={4}
        groups={2}
        value={code()}
        onChange={({ value }) => code.set(value)}
        onComplete={({ value }) => done.set(value)}
        onFocus={() => focused.set("yes")}
        onBlur={() => focused.set("no")}
        accessibilityLabel="Code"
        class="flex-row items-start gap-[10px]"
        groupClass="flex-row gap-[4px]"
        groupStyle={{ padding: 2 }}
        cellClass="w-[30px] min-h-[20px] text-[10px] leading-[12px] focus:bg-[#00ff00]"
        cellStyle={{ marginTop: 2 }}
        caretClass="w-[2px] h-[50px]"
        caretStyle={{ marginTop: 4 }}
      />
      <OtpInput length={3} defaultValue="12" masked disabled accessibilityLabel="Own" />
      <View testID="clear" onPress={() => code.set("")} style={{ height: 20 }} />
      <Text>{`Code [${code()}]`}</Text>
      <Text>{`Done [${done()}]`}</Text>
      <Text>{`Focused ${focused()}`}</Text>
    </View>
  );
}

export default App;
