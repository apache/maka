// A plain root whose nsh.json explicitly sets `application.quitMode: "platform"`
// stays running on macOS when its implicit main window closes.
import { mount, Text, View } from "nsh";

function App() {
  return (
    <View>
      <Text>Configured platform quit</Text>
    </View>
  );
}

mount(App);
