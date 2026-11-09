// Windows of the app's own, driven from the main window (windows.test.tsx,
// window-state.test.tsx). Every control is a button of the main window, at
// its top right, and every readout a text of the main window: the windows
// the tests open go to its bottom left corner (or where the platform puts
// them: GTK centers a dialog or a panel on its parent), so they never cover
// what a test presses on a real platform.
import { mount, signal, Text, View } from "nsh";
import { currentWindow, focusedWindow, Window, type WindowOptions, type WindowRef, type WindowState, windows } from "nsh/desktop";

const round = (n: number) => Math.round(n);

/** A window's state as one line the tests match. */
const describe = (s: WindowState | null | undefined) =>
  s
    ? `mode=${s.mode} minimized=${s.minimized} visible=${s.visible} focused=${s.focused} ` +
      `size=${round(s.bounds.size.width)}x${round(s.bounds.size.height)} ` +
      `content=${round(s.contentBounds.size.width)}x${round(s.contentBounds.size.height)}`
    : "none";

const opened = signal("none");
const notesSeen = signal("none");
const panelSeen = signal("none");
const closes = signal(0);
const outside = signal("not called");
const overlay = signal("not opened");

const panelOpen = signal(false);
const popupOpen = signal(false);
const dialogOpen = signal(false);
const guardOpen = signal(false);
const panelLog = signal("none");
const popupLog = signal("none");
const dialogLog = signal("none");
const guardLog = signal("none");

/** The main window, kept from the app's render: handlers have no window
 * to ask `currentWindow()` about. */
let main: WindowRef;

/** The main window's bottom left corner, where the windows open. */
function corner(): WindowOptions["defaultPosition"] {
  const b = main.state()?.bounds;
  return b ? { x: b.origin.x + 24, y: b.origin.y + b.size.height - 200 } : "center";
}

/** What the notes window shows: 240 × 120 points, the size it takes
 * with `sizeToContent`. */
function Notes() {
  const win = currentWindow();
  notesSeen.set(win.id);
  return (
    <View style={{ width: 240, height: 120, padding: 12 }}>
      <Text>{`Inside notes: ${win.id} ${win.main}`}</Text>
    </View>
  );
}

function PanelBody() {
  const win = currentWindow();
  panelSeen.set(win.id);
  return (
    <View style={{ flex: 1, padding: 12 }}>
      <Text>{`Inside panel: ${win.id}`}</Text>
    </View>
  );
}

function openNotes() {
  const first = Window.open(Notes, { id: "notes", title: "Notes", defaultSize: { width: 220, height: 140 }, defaultPosition: corner() });
  // Open already: the same window, whatever the options say.
  const second = Window.open(Notes, { id: "notes", title: "Other" });
  opened.set(first === second && Window.get("notes") === first ? "same ref" : "different refs");
  first.on("close", () => closes.set(closes() + 1));
}

const notes = () => Window.get("notes");

/** A button of the main window. */
function Action(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} style={{ width: 150, height: 22, justifyContent: "center", paddingHorizontal: 6, borderWidth: 1, borderRadius: 4 }}>
      <Text style={{ fontSize: 12 }}>{props.label}</Text>
    </View>
  );
}

function App() {
  main = currentWindow();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ position: "absolute", left: 12, top: 12, right: 340, gap: 2 }}>
        <Text>{`Main: ${main.id} ${main.main}`}</Text>
        <Text>{`Windows: ${windows().map((w) => w.id).join(",")}`}</Text>
        <Text>{`Get: main=${Window.get("main")?.id ?? "none"} notes=${notes()?.id ?? "none"}`}</Text>
        <Text>{`Focused: ${focusedWindow()?.id ?? "none"}`}</Text>
        <Text>{`Opened: ${opened()}`}</Text>
        <Text>{`Notes inside: ${notesSeen()}`}</Text>
        <Text>{`Panel inside: ${panelSeen()}`}</Text>
        <Text>{`Close events: ${closes()}`}</Text>
        <Text>{`Outside: ${outside()}`}</Text>
        <Text>{`Overlay: ${overlay()}`}</Text>
        <Text>{`Notes: ${describe(notes()?.state())}`}</Text>
        <Text>{`Panel: ${describe(Window.get("panel")?.state())}`}</Text>
        <Text>{`Popup: ${describe(Window.get("popup")?.state())}`}</Text>
        <Text>{`Dialog: ${describe(Window.get("dialog")?.state())}`}</Text>
        <Text>{`Panel log: ${panelLog()}`}</Text>
        <Text>{`Popup log: ${popupLog()}`}</Text>
        <Text>{`Dialog log: ${dialogLog()}`}</Text>
        <Text>{`Guard log: ${guardLog()}`}</Text>
      </View>
      <View style={{ position: "absolute", right: 12, top: 12, width: 312, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        <Action label="Open notes" onPress={openNotes} />
        <Action label="Close notes" onPress={() => notes()?.close()} />
        <Action label="Resize notes" onPress={() => notes()?.setBounds({ size: { width: 360, height: 240 } })} />
        <Action label="Fit notes" onPress={() => notes()?.set({ sizeToContent: true })} />
        <Action label="Maximize notes" onPress={() => notes()?.setMode("maximized")} />
        <Action label="Normal notes" onPress={() => notes()?.setMode("normal")} />
        <Action label="Minimize notes" onPress={() => notes()?.minimize()} />
        <Action label="Restore notes" onPress={() => notes()?.restore()} />
        <Action label="Open panel" onPress={() => panelOpen.set(true)} />
        <Action label="Close panel" onPress={() => panelOpen.set(false)} />
        <Action label="Open popup" onPress={() => popupOpen.set(true)} />
        <Action label="Open dialog" onPress={() => dialogOpen.set(true)} />
        <Action label="Open guard" onPress={() => guardOpen.set(true)} />
        <Action label="Close guard" onPress={() => Window.get("guard")?.close()} />
        <Action label="Focus main" onPress={() => main.focus()} />
        <Action
          label="Call outside"
          onPress={() => {
            try {
              currentWindow();
              outside.set("no error");
            } catch (e) {
              outside.set((e as Error).name);
            }
          }}
        />
        <Action
          label="Open overlay"
          onPress={() => {
            try {
              Window.open(Notes, { id: "overlay", kind: "overlay" });
              overlay.set("opened");
            } catch (e) {
              const error = e as { code?: string; permission?: string };
              overlay.set(`${error.code} ${error.permission}`);
            }
          }}
        />
      </View>
      {/* A panel, controlled: the app closing it hears no onOpenChange. */}
      <Window
        id="panel"
        kind="panel"
        parent="main"
        title="Panel"
        open={panelOpen()}
        onOpenChange={({ open, reason }) => {
          panelOpen.set(open);
          panelLog.set(reason);
        }}
        defaultSize={{ width: 220, height: 140 }}
        defaultPosition={corner()}
      >
        <PanelBody />
      </Window>
      {/* A popup: Escape and losing the focus close it (its kind's). */}
      <Window
        id="popup"
        kind="popup"
        open={popupOpen()}
        onOpenChange={({ open, reason }) => {
          popupOpen.set(open);
          popupLog.set(reason);
        }}
        defaultSize={{ width: 220, height: 140 }}
        defaultPosition={corner()}
      >
        <Text>Inside popup</Text>
      </Window>
      {/* A dialog: Escape closes it (its kind's). */}
      <Window
        id="dialog"
        kind="dialog"
        parent="main"
        title="Dialog"
        open={dialogOpen()}
        onOpenChange={({ open, reason }) => {
          dialogOpen.set(open);
          dialogLog.set(reason);
        }}
        defaultSize={{ width: 220, height: 140 }}
        defaultPosition={corner()}
      >
        <Text>Inside dialog</Text>
      </Window>
      {/* A window its close button does not close: the app hears the press
          and closes it itself. */}
      <Window
        id="guard"
        title="Guard"
        closeOnPress={false}
        open={guardOpen()}
        onClosePress={({ reason }) => guardLog.set(`closePress ${reason}`)}
        onOpenChange={({ open, reason }) => {
          guardOpen.set(open);
          guardLog.set(`closed ${reason}`);
        }}
        defaultSize={{ width: 220, height: 140 }}
        defaultPosition={corner()}
      >
        <Text>Inside guard</Text>
      </Window>
    </View>
  );
}

mount(App);
