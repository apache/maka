import { mount, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";

const presses = signal(0);

function App() {
  return (
    <View class="flex-1">
      <Text testID="count">{`presses=${presses()}`}</Text>
      <Dialog open accessibilityLabel="Probe" class="p-4">
        <View testID="inside" onPress={() => presses.set(presses() + 1)} class="w-32 h-8">
          <Text>Press me</Text>
        </View>
      </Dialog>
    </View>
  );
}

mount(App);
