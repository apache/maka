import { mount, signal, Text, View } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, size, Split, tint, ui } from "./palette";

// What each section shows: the app switches the content by its own value.
const sections = [
  {
    id: "overview",
    label: "Overview",
    rows: [
      ["Visitors", "12,480"],
      ["Sign-ups", "342"],
      ["Conversion", "2.74%"],
    ],
  },
  {
    id: "activity",
    label: "Activity",
    rows: [
      ["Deploy to production", "09:41"],
      ["Invoice paid", "08:15"],
      ["New member joined", "07:02"],
    ],
  },
  {
    id: "settings",
    label: "Settings",
    rows: [
      ["Region", "Frankfurt"],
      ["Plan", "Pro"],
      ["Seats", "8 of 10"],
    ],
  },
];
const folders = [
  { id: "inbox", label: "Inbox", count: 12 },
  { id: "archive", label: "Archive", count: 0 },
  { id: "spam", label: "Spam", count: 3, locked: true },
];

function App() {
  const section = signal("overview");
  const folder = signal("inbox");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  const current = () => sections.find((s) => s.id === section())!;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>tabs</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click a tab, or Tab to a list and move with the arrow keys" : "Tap a tab to show its section"}
      </Text>

      <Split gap={14} inspector={<Log title={`onPress · ${section()}, ${folder()}`} lines={events()} minHeight={76} />}>
        {/* A segmented tab list: each tab is a segment, and the list's indicator is the raised one, inside the
            list's padding, which springs to the tab the app selects. */}
        <Tabs
          style={{ flexDirection: "row", gap: 4, padding: 3, borderRadius: 10, ...ui().inset, ...(desktop ? { alignSelf: "flex-start" } : {}) }}
          indicatorStyle={{ top: 3, bottom: 3, borderRadius: 7, ...ui().raised }}
        >
          <Each of={sections}>
            {(s) => (
              <Tab
                selected={section() === s().id}
                onPress={() => {
                  section.set(s().id);
                  log(`${s().label} pressed`);
                }}
                style={
                  desktop
                    ? { height: 26, paddingHorizontal: 14, borderRadius: 7, alignItems: "center", justifyContent: "center" }
                    : { flex: 1, height: 30, borderRadius: 7, alignItems: "center", justifyContent: "center" }
                }
                class="active:opacity-70"
                hoverStyle={section() === s().id ? undefined : hoverFill()}
                focusStyle={focusRing()}
              >
                <Text style={{ fontSize: 13, fontWeight: "500", color: section() === s().id ? ui().text : ui().muted }}>
                  {s().label}
                </Text>
              </Tab>
            )}
          </Each>
        </Tabs>

        {/* The selected section's content, which the app shows by its value. */}
        <View style={{ ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <Each of={current().rows}>
            {(row, i) => (
              <>
                {i() > 0 ? <View style={{ height: 1, marginLeft: desktop ? 12 : 16, backgroundColor: ui().line }} /> : null}
                <View
                  style={
                    desktop
                      ? { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, height: size.row }
                      : { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 }
                  }
                >
                  <Text style={{ flex: 1, fontSize: size.label, color: ui().text }}>{row()[0]}</Text>
                  <Text style={{ fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"], color: ui().muted }}>{row()[1]}</Text>
                </View>
              </>
            )}
          </Each>
        </View>

        {/* Tabs with counts: the selected one's own fill, a disabled one dimmed. */}
        <Tabs style={{ flexDirection: "row", gap: 6 }}>
          <Each of={folders}>
            {(f) => (
              <Tab
                selected={folder() === f().id}
                disabled={f().locked}
                onPress={() => {
                  folder.set(f().id);
                  log(`${f().label} pressed`);
                }}
                class="active:opacity-70 disabled:opacity-40"
                hoverStyle={f().locked || folder() === f().id ? undefined : hoverFill()}
                focusStyle={focusRing()}
                style={{ flexDirection: "row", alignItems: "center", gap: 6, height: desktop ? size.controlSm : 30, paddingHorizontal: desktop ? 10 : 12, borderRadius: 8 }}
                selectedStyle={{ backgroundColor: tint(ui().accent, 0.16) }}
              >
                <Text style={{ fontSize: 13, fontWeight: "500", color: folder() === f().id ? ui().accent : ui().muted }}>
                  {f().label}
                </Text>
                {f().count > 0 ? (
                  <Text style={{ fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"], color: ui().faint }}>{f().count}</Text>
                ) : null}
              </Tab>
            )}
          </Each>
        </Tabs>
      </Split>
    </View>
  );
}

mount(App);
