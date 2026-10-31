// A case of the API's test suite (docs/dev/compatibility.md): `Tab` and
// `Tabs` of `nsh/base`, the tabs of a tab list and the list, with no look
// of their own: the roles and states screen readers get
// (`accessibilityLabel`), a press reported with `onPress` (the selected
// tab's too) while the app owns which tab is selected (`selected`) and
// shows its content, `disabled`, the list as one stop of the keyboard
// focus (only the selected tab is `focusable`), and the app's look of a tab
// (`selectedStyle`) and of the marker it puts inside, whose
// `group-selected:` and `group-disabled:` classes follow the tab. The
// marker's widths move the label after it, which is how its script sees
// them. The list's indicator (`indicatorClass`, `indicatorStyle`) is a bar
// at the left of the column of tabs, inside margins of 2 along it, which
// the core places on the selected tab (the view below the first tab).
import { Text, View, signal } from "nsh";
import { Tab, Tabs } from "nsh/base";

const marker = "mr-[8px] h-[20px] w-[20px] group-selected:w-[30px] group-disabled:w-[10px]";

function App() {
  const current = signal("overview");
  const presses = signal(0);
  const disabled = signal(true);
  const section = (value: string, label: string, locked = false) => (
    <Tab
      testID={value}
      selected={current() === value}
      disabled={locked && disabled()}
      accessibilityLabel={locked ? `${label} section` : undefined}
      class="group flex-row items-center"
      selectedStyle={{ backgroundColor: "#00ff00" }}
      onPress={() => {
        presses.set(presses() + 1);
        current.set(value);
      }}
    >
      <View class={marker} />
      <Text>{label}</Text>
    </Tab>
  );
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Tabs
        testID="sections"
        class="gap-[4px]"
        indicatorClass="left-0 w-[3px] my-[2px]"
        indicatorStyle={{ backgroundColor: "#ff0000" }}
      >
        {section("overview", "Overview")}
        {section("activity", "Activity")}
        {section("billing", "Billing", true)}
      </Tabs>
      <Text>{`Showing: ${current()}`}</Text>
      <Text>{`Presses: ${presses()}`}</Text>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
