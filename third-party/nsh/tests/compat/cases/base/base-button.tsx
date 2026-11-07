// A case of the API's test suite (docs/dev/compatibility.md): `Button` of
// `nsh/base`, a press target with no look of its own: presses
// (`onPress`, and `onPressDown` / `onPressUp` as the platform reports
// them), its role and states as screen readers get them (`role`,
// `accessibilityLabel`, `selected`, `disabled`), the app's look (`style`,
// `class`, `selectedStyle` while selected, `disabledStyle` while
// disabled), how far outside it presses count (`hitSlop`, a number for
// every side or some sides), all following signals. Its script checks
// each.
import { Text, View, signal } from "nsh";
import { Button } from "nsh/base";

function App() {
  const presses = signal(0);
  const downs = signal(0);
  const ups = signal(0);
  const selected = signal(false);
  const disabled = signal(true);
  const blocked = signal(0);
  const wide = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Button
        testID="plain"
        onPress={() => presses.set(presses() + 1)}
        onPressDown={() => downs.set(downs() + 1)}
        onPressUp={() => ups.set(ups() + 1)}
        style={{ height: 40, backgroundColor: "#336699" }}
      >
        <Text>Press me</Text>
      </Button>
      <Text>{`Presses: ${presses()}`}</Text>
      <Text>{`Downs: ${downs()}, ups: ${ups()}`}</Text>
      <Button
        testID="tab"
        role="tab"
        selected={selected()}
        selectedStyle={{ backgroundColor: "#00ff00" }}
        class="h-[30px] bg-[#cccccc]"
        onPress={() => selected.set(!selected())}
      >
        <Text>Tab</Text>
      </Button>
      <Button testID="icon" accessibilityLabel="Close the panel" onPress={() => presses.set(presses() + 10)}>
        <Text>×</Text>
      </Button>
      <Button
        testID="blocked"
        disabled={disabled()}
        disabledStyle={{ opacity: 0.5 }}
        onPress={() => blocked.set(blocked() + 1)}
      >
        <Text>Blocked</Text>
      </Button>
      <Text>{`Blocked presses: ${blocked()}`}</Text>
      <Button testID="off" disabled onPress={() => blocked.set(blocked() + 100)}>
        <Text>Always off</Text>
      </Button>
      <Button testID="enable" onPress={() => disabled.set(!disabled())}>
        <Text>Toggle blocked</Text>
      </Button>
      <Button testID="close" hitSlop={12} accessibilityLabel="Close" onPress={() => presses.set(presses() + 100)}>
        <Text>×</Text>
      </Button>
      <Button testID="sides" hitSlop={wide() ? { top: 4, left: 2 } : 0} onPress={() => wide.set(!wide())}>
        <Text>Widen</Text>
      </Button>
    </View>
  );
}

export default App;
