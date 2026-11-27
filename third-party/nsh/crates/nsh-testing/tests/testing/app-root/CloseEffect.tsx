// Closing a window while an effect reads `windowState()` and `titleBar()`
// settles to `null` and all zeros instead of throwing `TypeError`.
import { effect, mount, signal, Storage, Text, View } from "nsh";
import { titleBar, Window, windowState } from "nsh/desktop";

function App() {
  const open = signal(true);
  effect(() => {
    const s = windowState();
    const b = titleBar();
    void Storage.setItem("close.state", `${s ? s.contentBounds.size.width : "null"} ${b.height}`);
  });
  return (
    <Window id="main" open={open()} onOpenChange={({ open: now }) => open.set(now)}>
      <View>
        <Text>Open</Text>
      </View>
    </Window>
  );
}

mount(App);
