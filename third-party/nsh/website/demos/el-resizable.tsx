import { mount, signal, Text, View } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { desktop, Log, Panel, Segmented, Split, ui, wide } from "./palette";

// The sizes are the app's: the group reports them when a drag ends, and the
// app passes them back as each panel's `size`.
function App() {
  const sidebar = signal(desktop ? 220 : 140);
  const consoleSize = signal(120);
  const showConsole = signal<"Shown" | "Hidden">("Shown");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  const round = (sizes: number[]) => sizes.map((s) => Math.round(s)).join(" · ");

  // The handles' look: a hairline that lights up under the pointer and while dragged.
  const handle = "bg-border group-hover:bg-muted-foreground group-active:bg-primary";

  const label = (title: string, detail: string) => (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: ui().text }}>{title}</Text>
      <Text style={{ fontSize: 12, color: ui().muted }}>{detail}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>resizable</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Drag a line between two panels" : "Drag a line between two panels with your finger"}
      </Text>

      <Split
        grow
        width={640}
        inspector={
          <>
            <Panel title="sizes">
              <Text style={{ fontSize: 13, fontVariant: ["tabular-nums"], color: ui().text }}>
                {`sidebar ${Math.round(sidebar())} · console ${Math.round(consoleSize())}`}
              </Text>
            </Panel>
            <Segmented label="console" options={["Shown", "Hidden"] as const} value={showConsole()} onChange={(v) => showConsole.set(v)} />
            <Log title="onResize" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 360 : 300, ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <ResizablePanelGroup
            axis="horizontal"
            handleClass={handle}
            handleAccessibilityLabel="Resize the sidebar"
            onResize={({ sizes }) => log(`row: ${round(sizes)}`)}
          >
            <ResizablePanel size={sidebar()} minSize={100} maxSize={320} onResize={({ size }) => sidebar.set(size)}>
              <View style={{ flex: 1, padding: 14, gap: 10, backgroundColor: ui().inset.backgroundColor }}>
                {label("Files", `${Math.round(sidebar())} pt, 100 to 320`)}
              </View>
            </ResizablePanel>
            <ResizablePanel minSize={120}>
              <ResizablePanelGroup
                axis="vertical"
                handleClass={handle}
                handleAccessibilityLabel="Resize the console"
                onResize={({ sizes }) => log(`column: ${round(sizes)}`)}
              >
                <ResizablePanel minSize={80}>
                  <View style={{ flex: 1, padding: 14 }}>{label("Editor", "Takes the room left")}</View>
                </ResizablePanel>
                <ResizablePanel
                  size={consoleSize()}
                  minSize={60}
                  fixed
                  visible={showConsole() === "Shown"}
                  onResize={({ size }) => consoleSize.set(size)}
                >
                  <View style={{ flex: 1, padding: 14 }}>{label("Console", "Fixed: keeps its height")}</View>
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
          </ResizablePanelGroup>
        </View>
      </Split>
    </View>
  );
}

mount(App);
