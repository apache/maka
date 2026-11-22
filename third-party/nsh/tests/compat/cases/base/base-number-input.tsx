// A case of the API's test suite (docs/dev/compatibility.md): `NumberInput`
// of `nsh/base`, a number typed in a field or stepped, with no look of its
// own: its field a spin button with its label and value for screen readers
// (`accessibilityLabel`, between `min` and `max`), steps of `step` from a
// screen reader's increment and the buttons the app fills
// (`incrementButton`, `decrementButton`) reported by `onChange` while the
// app owns the value (`value`), or the input its own (`defaultValue`),
// typing reported and held to `max` when the field is left (`onFocus`,
// `onBlur`, `onSubmit`), `placeholder`, `disabled`, `readonly`, the buttons
// on the right (`controlsRight`), and the app's look of its field, buttons
// and controls column (`inputClass`, `inputStyle`, `decrementButtonClass`,
// `decrementButtonStyle`, `incrementButtonClass`, `incrementButtonStyle`,
// `controlsClass`, `controlsStyle`), whose `disabled:` classes follow the
// input. The parts' frames are how its script sees them; the app's element
// in `prefix` and `suffix` lays out in the component's row as its own child
// would (`flex: 1` takes what the row leaves, a percentage is of the row).
import { Text, View, signal } from "nsh";
import { NumberInput } from "nsh/base";

const parts = {
  class: "flex-row",
  inputClass: "w-[100px] h-[30px]",
  inputStyle: { backgroundColor: "#eeeeee" },
  decrementButtonClass: "w-[30px] h-[30px] disabled:w-[20px]",
  decrementButtonStyle: { backgroundColor: "#ff0000" },
  incrementButtonClass: "w-[30px] h-[30px] disabled:w-[20px]",
  incrementButtonStyle: { backgroundColor: "#00ff00" },
};

function App() {
  const quantity = signal<number | null>(2);
  const amount = signal("none");
  const events = signal<string[]>([]);
  const log = (event: string) => events.set([...events(), event]);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <NumberInput
        value={quantity()}
        onChange={({ value }) => quantity.set(value)}
        min={0}
        max={10}
        step={0.5}
        accessibilityLabel="Quantity"
        decrementButton={<Text>Less</Text>}
        incrementButton={<Text>More</Text>}
        {...parts}
      />
      <Text>{`Quantity ${quantity()}`}</Text>
      <NumberInput
        defaultValue={4}
        max={10}
        placeholder="Amount"
        accessibilityLabel="Amount"
        onChange={({ value }) => amount.set(String(value))}
        onFocus={() => log("focus")}
        onBlur={() => log("blur")}
        onSubmit={({ value }) => log(`submit ${value}`)}
        controlsRight
        class="flex-row"
        inputClass="w-[100px] h-[30px]"
        controlsClass="w-[30px] h-[30px]"
        controlsStyle={{ backgroundColor: "#0000ff" }}
        incrementButtonClass="flex-1"
        decrementButtonClass="flex-1"
        incrementButton={<Text>Up</Text>}
        decrementButton={<Text>Down</Text>}
        prefix={<Text>about</Text>}
        suffix={<Text>kg</Text>}
      />
      <Text>{`Amount ${amount()}`}</Text>
      <Text>{`Events ${events().join(" ")}`}</Text>
      <NumberInput
        value={5}
        disabled
        accessibilityLabel="Locked"
        decrementButton={<Text>Locked less</Text>}
        incrementButton={<Text>Locked more</Text>}
        {...parts}
      />
      <NumberInput value={5} readonly accessibilityLabel="Fixed" {...parts} />
      <View style={{ width: 300 }}>
        <NumberInput
          accessibilityLabel="Weight"
          class="flex-row"
          inputClass="w-[100px] h-[30px]"
          prefix={<View testID="weight-prefix" style={{ flex: 1, height: 10 }} />}
          suffix={<View testID="weight-suffix" style={{ width: "10%", height: 10 }} />}
        />
      </View>
    </View>
  );
}

export default App;
