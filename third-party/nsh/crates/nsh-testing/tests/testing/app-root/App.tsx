// A released desktop app's root: a plain view, and the main window ref in
// the root while it renders, as `mount(App)` gave the old model's main
// window. `mount` renders the view in the implicit first window (`main`).
import { mount, signal, Text, View } from "nsh";
import { currentWindow, titleBar, windowState } from "nsh/desktop";

function App() {
  const win = currentWindow();
  win.set({ title: "Implicit" });
  const bar = titleBar();
  const outside = signal("none");
  const readOutside = () => {
    const b = titleBar();
    const s = windowState();
    return `${b.height} ${s ? s.contentBounds.size.width : "null"}`;
  };
  return (
    <View>
      <Text>No window</Text>
      <Text>{`Bar: ${bar.height}`}</Text>
      <Text>{`Outside: ${outside()}`}</Text>
      <View
        onPress={() => {
          const sync = readOutside();
          Promise.resolve().then(() => {
            outside.set(`sync ${sync}, async ${readOutside()}`);
          });
        }}
        style={{ width: 120, height: 24 }}
      >
        <Text>Read outside</Text>
      </View>
    </View>
  );
}

mount(App);
