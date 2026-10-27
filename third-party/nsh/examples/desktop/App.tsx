// A desktop app with a title bar of its own: the system's is hidden, the
// app draws a bar that drags the window (`desktop={{ windowDrag: true }}`)
// and leaves room for the system's window controls (`titleBar()`). The
// application menu is macOS's menu bar; on Windows and Linux, whose menu
// bar does not show with the title bar hidden, the bar's buttons open its
// menus with `Menu.popup` (the shortcuts work everywhere).

import { effect, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { colorScheme, platform } from "nsh";
import { Menu, type MenuItem, titleBar, Window } from "nsh/desktop";

Window.setTitle("nsh desktop");

const mac = platform.os === "macos";

function App() {
  const log = signal<string[]>([]);
  const wrap = signal(true);
  const hidden = signal(true);
  const say = (line: string) => log.update((l) => [line, ...l].slice(0, 12));
  const dark = () => colorScheme() === "dark";

  const menus = (): { label: string; submenu: MenuItem[] }[] => [
    {
      label: "File",
      submenu: [
        { label: "New", shortcut: "mod+n", onSelect: () => say("File > New") },
        { label: "Open…", shortcut: "mod+o", onSelect: () => say("File > Open") },
        { label: "Save", shortcut: "mod+s", disabled: true },
        { type: "separator" },
        { label: "Recent", submenu: [{ label: "notes.txt", onSelect: () => say("Recent > notes.txt") }] },
        ...(mac ? [] : [{ type: "separator" } as const, { role: "quit", label: "Exit" } as const]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Word Wrap", checked: wrap(), onSelect: () => wrap.update((w) => !w) },
        {
          label: "System Title Bar",
          checked: !hidden(),
          shortcut: "mod+shift+t",
          onSelect: () => hidden.update((h) => !h),
        },
        { type: "separator" },
        { role: "toggleFullScreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }],
    },
  ];

  effect(() => {
    // The bar is 40 points tall: the window controls are centered in it.
    Window.setTitleBar(hidden() ? "hidden" : "default", 40);
  });

  effect(() => {
    Menu.setApplicationMenu([
      mac && {
        label: "nsh desktop",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "showAll" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      ...menus(),
    ]);
  });

  // Where each menu button is, to open its menu below it.
  const buttons: Record<string, { x: number; width: number }> = {};
  // The menu open from the bar: its button stays pressed until it closes.
  const opened = signal<string | null>(null);
  const barHeight = () => titleBar().height || 40;

  return (
    <View style={{ flex: 1, backgroundColor: dark() ? "#111318" : "#f4f5f7" }}>
      <View
        desktop={{ windowDrag: true }}
        style={{
          height: barHeight(),
          paddingLeft: titleBar().left + 8,
          paddingRight: titleBar().right + 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          backgroundColor: dark() ? "#1b1e25" : "#e8eaef",
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "600", color: dark() ? "#e6e8ec" : "#1f2328", marginRight: 8 }}>
          nsh desktop
        </Text>
        <If when={!mac}>
          <Each of={menus()}>
            {(menu) => (
              <View
                onLayout={(e) => (buttons[menu().label] = { x: e.origin.x, width: e.size.width })}
                onPress={() => {
                  const label = menu().label;
                  opened.set(label);
                  Menu.popup(menu().submenu, { x: buttons[label]?.x ?? 0, y: barHeight() }).then(() => opened.set(null));
                }}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 }}
                class="hover:bg-black/10 active:bg-black/15 dark:hover:bg-white/10 dark:active:bg-white/15"
                classList={{ "bg-black/15 dark:bg-white/15": opened() === menu().label }}
              >
                <Text style={{ fontSize: 13, color: dark() ? "#e6e8ec" : "#1f2328" }}>{menu().label}</Text>
              </View>
            )}
          </Each>
        </If>
        <View style={{ flex: 1 }} />
        <Input
          placeholder="Search"
          style={{
            width: 180,
            height: 26,
            paddingHorizontal: 8,
            borderRadius: 6,
            fontSize: 13,
            backgroundColor: dark() ? "#111318" : "#ffffff",
            color: dark() ? "#e6e8ec" : "#1f2328",
          }}
        />
      </View>
      {/* Below the bar, so that the whole height the controls are centered in is the bar's. */}
      <View style={{ height: 1, backgroundColor: dark() ? "#2a2e37" : "#d5d8de" }} />
      <View style={{ flex: 1, padding: 24, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: "bold", color: dark() ? "#e6e8ec" : "#1f2328" }}>
          A title bar of the app's own
        </Text>
        <Text style={{ fontSize: 14, color: dark() ? "#9aa1ad" : "#59636e" }}>
          Drag the bar to move the window, double-click it to maximize. The search field and the menu buttons stay
          clickable. Title bar area: {titleBar().height} high, {titleBar().left} left, {titleBar().right} right.
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View
            onPress={() =>
              Menu.popup([
                { label: "Say hello", onSelect: () => say("Context > Say hello") },
                { label: "Disabled", disabled: true },
                { type: "separator" },
                { label: "Word Wrap", checked: wrap(), onSelect: () => wrap.update((w) => !w) },
              ])
            }
            style={{ backgroundColor: "#4f46e5", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }}
          >
            <Text style={{ color: "#ffffff", fontSize: 14 }}>Context menu</Text>
          </View>
          <View
            onPress={() => hidden.update((h) => !h)}
            style={{ backgroundColor: "#0f766e", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }}
          >
            <Text style={{ color: "#ffffff", fontSize: 14 }}>Toggle title bar</Text>
          </View>
        </View>
        <Text style={{ fontSize: 14, color: dark() ? "#9aa1ad" : "#59636e" }}>
          Word wrap: {wrap() ? "on" : "off"}
        </Text>
        <Each of={log()}>
          {(line) => <Text style={{ fontSize: 14, color: dark() ? "#e6e8ec" : "#1f2328" }}>• {line()}</Text>}
        </Each>
      </View>
    </View>
  );
}

mount(App);
