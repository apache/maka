// A case of the API's test suite (docs/dev/compatibility.md): `Toggle` and
// `ToggleGroup` of `nsh/base`, a button that is on or off and a toolbar of
// them, with no look of their own: the roles and states screen readers get
// (`accessibilityLabel`), a press reporting the next value (`onChange`)
// while the app owns which toggles are pressed (`pressed`), `disabled` on
// a toggle and on the whole group, the group as one stop of the keyboard
// focus (only the first pressed toggle is `focusable`), and the app's look
// of a toggle (`pressedStyle`) and of the marker it puts inside, whose
// `group-aria-pressed:` and `group-disabled:` classes follow the toggle.
// The marker's widths move the label after it, which is how its script
// sees them.
import { Text, View, signal } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";

const marker = "mr-[8px] h-[20px] w-[20px] group-aria-pressed:w-[30px] group-disabled:w-[10px]";
const MARKS = ["bold", "italic", "underline"];

function App() {
  const on = signal<string[]>(["italic"]);
  const changes = signal(0);
  const favorite = signal(false);
  const disabled = signal(true);
  const locked = signal(false);
  const mark = (value: string, label: string, lockable = false) => (
    <Toggle
      testID={value}
      pressed={on().includes(value)}
      disabled={lockable && disabled()}
      accessibilityLabel={lockable ? `${label} text` : undefined}
      class="group flex-row items-center"
      pressedStyle={{ backgroundColor: "#00ff00" }}
      onChange={({ pressed }) => {
        changes.set(changes() + 1);
        on.set(pressed ? [...on(), value] : on().filter(m => m !== value));
      }}
    >
      <View class={marker} />
      <Text>{label}</Text>
    </Toggle>
  );
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Toggle
        testID="favorite"
        pressed={favorite()}
        accessibilityLabel="Favorite"
        class="group flex-row items-center"
        onChange={({ pressed }) => favorite.set(pressed)}
      >
        <View class={marker} />
      </Toggle>
      <ToggleGroup testID="marks" class="flex-row gap-[4px]" disabled={locked()}>
        {mark("bold", "Bold")}
        {mark("italic", "Italic")}
        {mark("underline", "Underline", true)}
      </ToggleGroup>
      <Text>{`Marks: ${MARKS.filter(m => on().includes(m)).join(",") || "none"}`}</Text>
      <Text>{`Changes: ${changes()}`}</Text>
      <Text>{`Favorite: ${favorite()}`}</Text>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
      <View testID="lock" onPress={() => locked.set(!locked())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
