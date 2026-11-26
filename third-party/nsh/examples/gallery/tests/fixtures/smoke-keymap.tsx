// Bindings the platform's own menus or text system could take first: undo,
// redo (Cmd+Shift+Z on macOS, longbridge/nsh#3245) and select all.
import { keymap, mount, signal, Text, View } from "nsh";

const log = signal<string[]>([]);
for (const keys of ["mod+z", "mod+shift+z", "mod+a"]) keymap.bind(keys, () => log.set([...log(), keys]));

mount(() => (
  <View class="flex-1 p-4 bg-black">
    <Text testID="log" class="text-white">{`log: ${log().join(" ")}`}</Text>
  </View>
));
