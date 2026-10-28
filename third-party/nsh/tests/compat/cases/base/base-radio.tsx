// A case of the API's test suite (docs/dev/compatibility.md): `Radio` and
// `RadioGroup` of `nsh/base`, a set of options the user picks one of,
// with no look of their own: the roles and states screen readers get
// (`accessibilityLabel`), a press on an unchecked radio asking for `true`
// (`onChange`) while the app owns which one is checked (`checked`), a
// checked radio that stays checked, `disabled`, the group as one stop of
// the keyboard focus (only the checked radio is `focusable`), and the app's look of a
// radio (`checkedStyle`) and of the dot it puts inside, whose
// `group-checked:` and `group-disabled:` classes follow the radio. The
// dot's widths move the label after it, which is how its script sees
// them.
import { Text, View, signal } from "nsh";
import { Radio, RadioGroup } from "nsh/base";

const dot = "mr-[8px] h-[20px] w-[20px] group-checked:w-[30px] group-disabled:w-[10px]";

function App() {
  const plan = signal("basic");
  const changes = signal(0);
  const disabled = signal(true);
  const option = (value: string, label: string, locked = false) => (
    <Radio
      testID={value}
      checked={plan() === value}
      disabled={locked && disabled()}
      accessibilityLabel={locked ? `${label} plan` : undefined}
      class="group flex-row items-center"
      checkedStyle={{ backgroundColor: "#00ff00" }}
      onChange={({ checked }) => {
        changes.set(changes() + 1);
        if (checked) plan.set(value);
      }}
    >
      <View class={dot} />
      <Text>{label}</Text>
    </Radio>
  );
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <RadioGroup testID="plans" class="gap-[4px]">
        {option("basic", "Basic")}
        {option("pro", "Pro")}
        {option("team", "Team", true)}
      </RadioGroup>
      <Text>{`Plan: ${plan()}`}</Text>
      <Text>{`Changes: ${changes()}`}</Text>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
