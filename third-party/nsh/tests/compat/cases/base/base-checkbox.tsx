// A case of the API's test suite (docs/dev/compatibility.md): `Checkbox`
// of `nsh/base`, a checked / unchecked / indeterminate control with no
// look of its own: its role and value as screen readers get them
// (`accessibilityLabel`, `role`), presses reporting the next value
// (`onChange`) while the app owns it (`checked`, `indeterminate`),
// `disabled`, and the app's look of the checkbox (`checkedStyle`,
// `indeterminateStyle`) and of its indicator (`indicatorClass`,
// `indicatorStyle`) with the app's mark inside it (`indicator`), whose
// `checked:`, `indeterminate:` and `disabled:` classes follow the
// checkbox. The indicator's widths move the label after it, which is how
// its script sees them.
import { Text, View, signal } from "nsh";
import { Checkbox } from "nsh/base";

const parts = {
  class: "flex-row items-center",
  indicatorClass: "h-[20px] w-[20px] checked:w-[30px] indeterminate:w-[24px] disabled:w-[10px]",
  indicatorStyle: { marginRight: 8 },
};

function App() {
  const all = signal(false);
  const some = signal(true);
  const changes = signal(0);
  const asked = signal("");
  const disabled = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Checkbox
        testID="all"
        checked={all()}
        indeterminate={some()}
        checkedStyle={{ backgroundColor: "#00ff00" }}
        indeterminateStyle={{ backgroundColor: "#ffff00" }}
        onChange={({ checked }) => {
          changes.set(changes() + 1);
          some.set(false);
          all.set(checked);
        }}
        indicator={<Text>{some() ? "Mark: some" : all() ? "Mark: all" : "Mark: none"}</Text>}
        {...parts}
      >
        <Text>All</Text>
      </Checkbox>
      <Text>{`Changes: ${changes()}`}</Text>
      <Checkbox testID="kept" checked accessibilityLabel="Kept" onChange={({ checked }) => asked.set(String(checked))} {...parts} />
      <Text>{`Asked: ${asked()}`}</Text>
      <Checkbox testID="menu" role="menuitem" {...parts}>
        <Text>Menu</Text>
      </Checkbox>
      <Checkbox
        testID="locked"
        disabled={disabled()}
        onChange={() => changes.set(changes() + 10)}
        {...parts}
      >
        <Text>Locked</Text>
      </Checkbox>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
