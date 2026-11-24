// Windows of the app's own as headless runs play a desktop's: they open
// shown and focused (a panel without the focus), a press in one focuses
// it, a popup closes when the focus leaves it, Escape closes a dialog,
// and the close button reports its press and closes unless the window
// keeps itself open. Each window's button sits where the main window's
// does: a press goes to the window the view is in. The app root declares
// every window; there is no implicit main window.
import { keymap, mount, signal, Text, View } from "nsh";
import { Application, currentWindow, focusedWindow, Window } from "nsh/desktop";

const presses = signal("none");
const notesOpen = signal(false);
const popupOpen = signal(false);
const dialogOpen = signal(false);
const guardOpen = signal(false);
const log = signal("none");

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} style={{ width: 120, height: 24 }}>
      <Text>{props.label}</Text>
    </View>
  );
}

/** A window's one button, where the main window's first is. */
function Inside(props: { name: string }) {
  const win = currentWindow();
  // A binding made in a window's content fires only in that window.
  keymap.bind("mod+shift+k", () => log.set(`key in ${win.id}`));
  return <Button label={`In ${props.name}`} onPress={() => presses.set(`${props.name} in ${win.id}`)} />;
}

function Main() {
  keymap.bind("mod+shift+k", () => log.set("key in main"));
  return (
    <View style={{ flex: 1 }}>
      <Button label="Main button" onPress={() => presses.set("main")} />
      <Button label="Open notes" onPress={() => notesOpen.set(true)} />
      <Button
        label="Open notes again"
        onPress={() => Window.open(() => <Inside name="notes" />, { id: "notes" })}
      />
      <Button label="Open popup" onPress={() => popupOpen.set(true)} />
      <Button label="Open dialog" onPress={() => dialogOpen.set(true)} />
      <Button label="Open guard" onPress={() => guardOpen.set(true)} />
      <Button label="Close guard" onPress={() => Window.get("guard")?.close()} />
      <Button label="Quit" onPress={() => Application.quit()} />
      <Text>{`Presses: ${presses()}`}</Text>
      <Text>{`Focused: ${focusedWindow()?.id ?? "none"}`}</Text>
      <Text>{`Log: ${log()}`}</Text>
    </View>
  );
}

function App() {
  // An app-level shortcut is explicit and fires from every window.
  keymap.bind("mod+shift+a", () => log.set("app key"), { scope: "app" });
  const changed = (name: string, flag: { set(open: boolean): void }) => ({ open, reason }: { open: boolean; reason: string }) => {
    flag.set(open);
    log.set(`${name} ${reason}`);
  };
  return (
    <>
      <Window id="main">
        <Main />
      </Window>
      <Window id="notes" title="Notes" open={notesOpen()} onOpenChange={changed("notes", notesOpen)} defaultSize={{ width: 300, height: 200 }} defaultPosition={{ x: 40, y: 60 }}>
        <Inside name="notes" />
      </Window>
      <Window id="popup" kind="popup" open={popupOpen()} onOpenChange={changed("popup", popupOpen)}>
        <Inside name="popup" />
      </Window>
      <Window id="dialog" kind="dialog" parent="main" open={dialogOpen()} onOpenChange={changed("dialog", dialogOpen)}>
        <Inside name="dialog" />
      </Window>
      <Window
        id="guard"
        closeOnPress={false}
        open={guardOpen()}
        onClosePress={({ reason }) => log.set(`guard closePress ${reason}`)}
        onOpenChange={changed("guard", guardOpen)}
      >
        <Inside name="guard" />
      </Window>
    </>
  );
}

mount(App);
