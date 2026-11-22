import { mount, signal, Text, View } from "nsh";
import { Button, Tooltip } from "nsh/base";

// A component's `tooltip` (a host prop, as `class`) shows as a view's does.
function App() {
  const presses = signal(0);
  return (
    <View class="flex-1 items-center justify-center gap-8">
      <Button
        accessibilityLabel="button"
        onPress={() => presses.set(presses() + 1)}
        tooltip={<Tooltip><Text>tip on button</Text></Tooltip>}
      >
        <Text>Button</Text>
      </Button>
      <Button accessibilityLabel="disabled" disabled tooltip={<Tooltip><Text>tip on disabled</Text></Tooltip>}>
        <Text>Disabled</Text>
      </Button>
      <Text>{`presses ${presses()}`}</Text>
    </View>
  );
}
mount(App);
