import { mount, signal, Text, View } from "nsh";
import { Button, TitleBar } from "nsh/base";
import { desktop, ui } from "./palette";

// A window's chrome split in two, as an app with a sidebar draws it: the
// sidebar's bar and the content pane's bar. In a window with a hidden
// title bar each one steps aside of the window's controls only where it
// meets them; here (no window controls) neither pads.
function App() {
  const sidebar = signal(true);
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>title bar</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click the toggle to hide the sidebar" : "Tap the toggle to hide the sidebar"}</Text>
      <View style={{ height: 220, flexDirection: "row", borderWidth: 1, borderColor: ui().line, borderRadius: 10, overflow: "hidden" }}>
        <If when={sidebar()}>
          <View style={{ width: 180, ...ui().inset, borderWidth: 0, borderEndWidth: 1, borderEndColor: ui().line }}>
            <TitleBar>
              <View style={{ flex: 1, height: 40, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: ui().text }}>Library</Text>
              </View>
            </TitleBar>
          </View>
        </If>
        <View style={{ flex: 1, backgroundColor: ui().page }}>
          <TitleBar style={{ borderBottomWidth: 1, borderBottomColor: ui().line }}>
            <View style={{ flex: 1, height: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 }}>
              <Button accessibilityLabel="Toggle sidebar" onPress={() => sidebar.set(!sidebar())} style={{ paddingHorizontal: 8, height: 26, borderRadius: 6, justifyContent: "center", ...ui().raised }}>
                <Text style={{ fontSize: 12, color: ui().text }}>{sidebar() ? "Hide sidebar" : "Show sidebar"}</Text>
              </Button>
              <Text style={{ fontSize: 13, fontWeight: "600", color: ui().text }}>Inbox</Text>
            </View>
          </TitleBar>
        </View>
      </View>
    </View>
  );
}

mount(App);
