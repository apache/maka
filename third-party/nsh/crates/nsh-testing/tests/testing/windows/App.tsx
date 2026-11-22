// Windows of the app's own as headless runs play a desktop's: they open
// shown and focused (a panel without the focus), a press in one focuses
// it, a popup closes when the focus leaves it, Escape closes a dialog,
// and the close button reports its press and closes unless the window
// keeps itself open. Each window's button sits where the main window's
// does: a press goes to the window the view is in.
import { mount, signal, Text, View } from "nsh";
import { currentWindow, focusedWindow, Window } from "nsh/desktop";

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
  return <Button label={`In ${props.name}`} onPress={() => presses.set(`${props.name} in ${win.id}`)} />;
}

function App() {
  const changed = (name: string, flag: { set(open: boolean): void }) => ({ open, reason }: { open: boolean; reason: string }) => {
    flag.set(open);
    log.set(`${name} ${reason}`);
  };
  return (
    <View style={{ flex: 1 }}>
      <Button label="Main button" onPress={() => presses.set("main")} />
      <Button label="Open notes" onPress={() => notesOpen.set(true)} />
      <Button label="Open popup" onPress={() => popupOpen.set(true)} />
      <Button label="Open dialog" onPress={() => dialogOpen.set(true)} />
      <Button label="Open guard" onPress={() => guardOpen.set(true)} />
      <Button label="Close guard" onPress={() => Window.get("guard")?.close()} />
      <Text>{`Presses: ${presses()}`}</Text>
      <Text>{`Focused: ${focusedWindow()?.id ?? "none"}`}</Text>
      <Text>{`Log: ${log()}`}</Text>
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
    </View>
  );
}

mount(App);
