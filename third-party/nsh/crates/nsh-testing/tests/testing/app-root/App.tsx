// A released desktop app's root: a plain view, and the main window ref in
// the root while it renders, as `mount(App)` gave the old model's main
// window. `mount` renders the view in the implicit first window (`main`).
import { mount, Text, View } from "nsh";
import { currentWindow, titleBar } from "nsh/desktop";

function App() {
  const win = currentWindow();
  win.set({ title: "Implicit" });
  const bar = titleBar();
  return (
    <View>
      <Text>No window</Text>
      <Text>{`Bar: ${bar.height}`}</Text>
    </View>
  );
}

mount(App);
