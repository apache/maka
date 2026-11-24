// A window whose mode the app changes again while AppKit still animates
// into or out of full screen, which ignores `toggleFullScreen:` until the
// animation is over. F and N ask for full screen and normal by key, as a
// click while the window animates may land elsewhere; H hides it. `FullScreen.test.tsx`
// runs it on the macOS host.
import { keymap, mount, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Window, currentWindow } from "nsh/desktop";

function App() {
  const window = currentWindow();
  keymap.bind("f", () => window?.setMode("fullScreen"));
  keymap.bind("n", () => window?.setMode("normal"));
  keymap.bind("h", () => window?.hide());
  return (
    <View style={{ flex: 1, padding: 16, gap: 8, backgroundColor: "white" }}>
      <Text>{() => `Mode: ${window?.state()?.mode ?? ""}`}</Text>
      <Text>{() => `Visible: ${window?.state()?.visible ?? ""}`}</Text>
      <Button
        accessibilityLabel="Full screen and back"
        onPress={() => {
          window?.setMode("fullScreen");
          window?.setMode("normal");
        }}
      >
        <Text>Full screen and back</Text>
      </Button>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
