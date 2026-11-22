// One short page of what the macOS host's test agent sends as the user's
// input: a field (typing, Select All), an app shortcut (`keymap`), the
// application menu's items (an enabled one, a disabled one and the Edit
// roles), a web view that takes trusted input (`sendInput`) and two buttons
// that report their presses' click counts. It runs where the apps of
// `nsh test --target macos` do (`App.test.tsx`).
import { keymap, mount, signal, Text, View, WebView, type WebViewRef } from "nsh";
import { Input } from "nsh/base";
import { Menu } from "nsh/desktop";

// The page reports each input event's `isTrusted` with the field's value.
const PAGE = `<!doctype html><body style="margin:0">
<input style="position:absolute;left:0;top:0;width:200px;height:40px"
  oninput="window.nsh.postMessage(event.isTrusted + ':' + this.value)"></body>`;

function App() {
  const counted = signal(0);
  const chosen = signal("none");
  const page = signal("none");
  const real = signal("asking");
  const clicks = signal("none");
  let web!: WebViewRef;
  keymap.bind("mod+k", () => counted.set(counted() + 1));
  WebView.inputAvailable().then((available) => real.set(`${available}`));
  Menu.setApplicationMenu([
    { label: "Fixture", submenu: [{ role: "quit" }] },
    {
      label: "File",
      submenu: [
        { label: "Ping", shortcut: "mod+j", onSelect: () => chosen.set("ping") },
        { label: "Locked", shortcut: "mod+l", disabled: true, onSelect: () => chosen.set("locked") },
        { label: "Control", shortcut: "ctrl+j", onSelect: () => chosen.set("ctrl-j") },
        { label: "Function", shortcut: "f5", onSelect: () => chosen.set("f5") },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "selectAll" }] },
  ]);
  const button = (label: string, onPress: (e: { clickCount: number }) => void) => (
    <View role="button" accessibilityLabel={label} onPress={onPress} style={{ height: 32, justifyContent: "center" }}>
      <Text>{label}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Input testID="note" placeholder="Note" style={{ height: 36 }} />
      <Text>{`Counted: ${counted()}`}</Text>
      <Text>{`Menu: ${chosen()}`}</Text>
      <Text>{`Page: ${page()}`}</Text>
      <Text>{`Trusted input: ${real()}`}</Text>
      <Text>{`Clicks: ${clicks()}`}</Text>
      <WebView ref={web} html={PAGE} onMessage={(e) => page.set(e.data)} style={{ width: 200, height: 40 }} />
      {button("Click page", () => web.sendInput({ type: "click", x: 20, y: 20 }))}
      {button("Type page", () => web.sendInput({ type: "text", text: "ab" }))}
      {button("Backspace page", () => web.sendInput({ type: "key", key: "Backspace" }))}
      {button("Count here", (e) => clicks.set(`here ${e.clickCount}`))}
      {button("Count there", (e) => clicks.set(`there ${e.clickCount}`))}
    </View>
  );
}

mount(App);
