// A plain root that explicitly opts into `quitMode: "platform"` at run time
// stays running on macOS when its implicit main window closes.
import { mount, Text, View } from "nsh";
import { Application } from "nsh/desktop";

function App() {
  Application.setQuitMode("platform");
  return (
    <View>
      <Text>Platform quit mode</Text>
    </View>
  );
}

mount(App);
