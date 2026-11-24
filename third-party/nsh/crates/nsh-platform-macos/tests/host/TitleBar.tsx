// A hidden title bar with a button in its strip, as apps place their own
// headers there: the window's toolbar lies over it (`chrome::apply_toolbar`).
// `TitleBar.test.tsx` runs it on the macOS host.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Window, currentWindow, titleBar } from "nsh/desktop";

function App() {
  currentWindow()?.set({ titleBar: { style: "hidden", height: 44 } });
  const presses = signal(0);
  const layout = signal({ width: 0, height: 0 });
  return (
    <View
      style={{ flex: 1 }}
      onLayout={({ bounds }) =>
        layout.set({ width: bounds.size.width, height: bounds.size.height })
      }
    >
      <View style={{ height: 44, flexDirection: "row", alignItems: "center", paddingLeft: titleBar().left + 12 }}>
        <Button onPress={() => presses.set(presses() + 1)} accessibilityLabel="Header button" style={{ paddingHorizontal: 12, height: 28, justifyContent: "center" }}>
          <Text>Header</Text>
        </Button>
      </View>
      <Text>{`Presses: ${presses()}`}</Text>
      <Text>{() => `Layout: ${Math.round(layout().width)}x${Math.round(layout().height)}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
