// Windows of the app's own, driven from the main window (windows.test.tsx,
// window-state.test.tsx). Every control is a button of the main window, at
// its top right, and every readout a text of the main window: the windows
// the tests open go to its bottom left corner (or where the platform puts
// them: GTK centers a dialog or a panel on its parent), so they never cover
// what a test presses on a real platform. The one control inside a window
// the app opens is the viewer's pin, which shows while the pointer is over
// the viewer.
import { mount, platform, signal, Text, View } from "nsh";
import { currentWindow, focusedWindow, Window, type WindowOptions, type WindowState, windows } from "nsh/desktop";

const round = (n: number) => Math.round(n);

/** A window's state as one line the tests match. */
const describe = (s: WindowState | null | undefined) =>
  s
    ? `mode=${s.mode} minimized=${s.minimized} visible=${s.visible} focused=${s.focused} ` +
      `size=${round(s.bounds.size.width)}x${round(s.bounds.size.height)} ` +
      `content=${round(s.contentBounds.size.width)}x${round(s.contentBounds.size.height)}`
    : "none";

/** Where a window is on its display: `fills` when it covers just the display's work area (what a maximized
 * window shows of itself), else its offset from the work area's corner. */
const onDisplay = (s: WindowState | null | undefined) => {
  const area = s?.display?.visibleBounds;
  if (!s || !area) return "none";
  const b = s.bounds;
  const near = (a: number, b: number) => Math.abs(a - b) < 1;
  if (near(b.origin.x, area.origin.x) && near(b.origin.y, area.origin.y) && near(b.size.width, area.size.width) && near(b.size.height, area.size.height)) return "fills";
  return `at=${round(b.origin.x - area.origin.x)},${round(b.origin.y - area.origin.y)}`;
};

/** Whether a window opened at the point the app asked for: `as asked`, `by the system` where the platform places
 * windows itself (GTK), else where it is and what was asked. */
const placed = (s: WindowState | null | undefined, asked: WindowOptions["defaultPosition"]) => {
  if (platform.os === "linux") return "by the system";
  if (!s) return "none";
  if (typeof asked !== "object") return `asked ${asked ?? "nothing"}`;
  const o = s.bounds.origin;
  if (Math.abs(o.x - asked.x) < 1 && Math.abs(o.y - asked.y) < 1) return "as asked";
  return `at=${round(o.x)},${round(o.y)} asked=${round(asked.x)},${round(asked.y)}`;
};

/** Where the notes window was asked to open. */
let notesAsked: WindowOptions["defaultPosition"];

const opened = signal("none");
const pins = signal(0);
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

/** The main window's bottom left corner, where the windows open. */
function corner(): WindowOptions["defaultPosition"] {
  const b = Window.get("main")?.state()?.bounds;
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

/** What the palette shows. */
function PaletteBody() {
  return (
    <View style={{ flex: 1, padding: 12 }}>
      <Text>Inside palette</Text>
    </View>
  );
}

/** A panel focused as it opens, as the docs' `Window.open(..).focus()`:
 * the focus asked for before its first frame is not lost. */
function openPalette() {
  const palette = Window.open(PaletteBody, { id: "palette", kind: "panel", parent: "main", title: "Palette", defaultSize: { width: 220, height: 140 }, defaultPosition: corner() });
  palette.focus();
}

/** What the viewer shows: a pin while the pointer is over it, as a
 * picture-in-picture window shows its controls. */
function Viewer() {
  const over = signal(false);
  return (
    <View testID="viewer-surface" onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)} style={{ flex: 1, padding: 12 }}>
      <If when={over()}>
        <View onPress={() => pins.set(pins() + 1)} style={{ alignSelf: "flex-start", paddingHorizontal: 6, borderWidth: 1, borderRadius: 4 }}>
          <Text>Pin viewer</Text>
        </View>
      </If>
    </View>
  );
}

function openViewer() {
  Window.open(Viewer, { id: "viewer", title: "Viewer", defaultSize: { width: 220, height: 140 }, defaultPosition: corner() });
}

function openNotes() {
  notesAsked = corner();
  const first = Window.open(Notes, { id: "notes", title: "Notes", defaultSize: { width: 220, height: 140 }, defaultPosition: notesAsked });
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

function Main() {
  const main = currentWindow();
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
        <Text>{`Pins: ${pins()}`}</Text>
        <Text>{`Notes: ${describe(notes()?.state())}`}</Text>
        <Text>{`Notes on display: ${onDisplay(notes()?.state())}`}</Text>
        <Text>{`Notes placed: ${placed(notes()?.state(), notesAsked)}`}</Text>
        <Text>{`Panel: ${describe(Window.get("panel")?.state())}`}</Text>
        <Text>{`Palette: ${describe(Window.get("palette")?.state())}`}</Text>
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
        <Action label="Open palette" onPress={openPalette} />
        <Action label="Open popup" onPress={() => popupOpen.set(true)} />
        <Action label="Open dialog" onPress={() => dialogOpen.set(true)} />
        <Action label="Open guard" onPress={() => guardOpen.set(true)} />
        <Action label="Close guard" onPress={() => Window.get("guard")?.close()} />
        <Action label="Focus main" onPress={() => main.focus()} />
        <Action label="Open viewer" onPress={openViewer} />
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
    </View>
  );
}

function App() {
  return (
    <>
      <Window id="main">
        <Main />
      </Window>
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
    </>
  );
}

mount(App);
