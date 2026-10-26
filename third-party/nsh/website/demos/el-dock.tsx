import { mount, signal, Text, View } from "nsh";
import { Button, DockArea, type DockAreaLayout, type DockAreaRef } from "nsh/base";
import { button, buttonText, desktop, focusRing, Log, Panel, Split, ui, wide } from "./palette";

// The panels' keys and what each shows. The layout lists the keys; the app
// renders a panel's content from its key, and the content moves with it.
const titles: Record<string, string> = {
  files: "Files",
  readme: "README.md",
  main: "main.rs",
  preview: "Preview",
  terminal: "Terminal",
  problems: "Problems",
};
const lines: Record<string, string[]> = {
  files: ["src/", "  main.rs", "  lib.rs", "README.md", "Cargo.toml"],
  readme: ["# Hopper", "", "A small app with a dockable workspace."],
  main: ["fn main() {", "    hopper::run();", "}"],
  preview: ["Hopper", "A small app with a dockable workspace."],
  terminal: ["$ cargo run", "   Compiling hopper v0.1.0", "    Finished dev in 1.92s"],
  problems: ["No problems"],
};

const initial: DockAreaLayout = {
  center: {
    type: "split",
    axis: "horizontal",
    children: [
      { type: "tabs", panels: ["readme", "main"], activeIndex: 1 },
      { type: "tabs", panels: ["preview"] },
    ],
    sizes: [null, 260],
  },
  left: { layout: { type: "tabs", panels: ["files"] }, size: 180 },
  bottom: { layout: { type: "tabs", panels: ["terminal", "problems"] }, size: 130 },
};

function App() {
  const layout = signal<DockAreaLayout>(initial);
  const locked = signal(false);
  // What shows now, in either presentation: the layout's docks when the area
  // is wide, the drawer or sheet presented when it is narrow. It starts from
  // the layout and follows onDockOpenChange.
  const shown = signal<Record<string, boolean>>({ left: true, bottom: true });
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  let area!: DockAreaRef;

  const toolbarButton = (label: string, onPress: () => void, on?: () => boolean) => (
    <Button onPress={onPress} selected={on?.() ?? false} {...button("secondary", { size: "sm", on })}>
      <Text style={buttonText("secondary", { on })}>{label}</Text>
    </Button>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>dock</Text>
      <Text style={{ color: ui().muted }}>
        {desktop
          ? "Drag a tab onto another group, or to a group's edge to split it"
          : "Tap Files or Terminal to open a dock; hold a tab to reorder it"}
      </Text>

      <Split
        grow
        width={720}
        inspector={
          <>
            <Panel title="docks">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {toolbarButton("Files", () => area.toggleDock("left"), () => shown().left)}
                {toolbarButton("Terminal", () => area.toggleDock("bottom"), () => shown().bottom)}
                {toolbarButton("Lock", () => locked.set(!locked()), locked)}
                {toolbarButton("Reset", () => layout.set(initial))}
              </View>
            </Panel>
            <Log title="events" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 420 : 460, ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <DockArea
            ref={area}
            class="flex-1"
            layout={layout()}
            onLayoutChange={(next) => {
              layout.set(next);
              log("onLayoutChange");
            }}
            onDockOpenChange={(placement, open) => {
              shown.set({ ...shown(), [placement]: open });
              log(`${placement} ${open ? "shown" : "hidden"}`);
            }}
            onPanelActiveChange={(panel, active) => active && log(`${titles[panel]} shown`)}
            locked={locked()}
            // The demo's two layouts: the full workspace beside the inspector in a
            // wide window, the phone presentation in one column. Without `compact`
            // the area decides by its own width (under 600 points: compact).
            compact={!wide()}
            groupClass="flex-1"
            tabBarClass="flex-row border-b border-border"
            tabClass="group px-3 py-1.5 selected:bg-muted"
            contentClass="flex-1"
            handleClass="bg-border group-hover:bg-muted-foreground group-active:bg-primary"
            handleAccessibilityLabel="Resize"
            dockClass="bg-muted/40"
            dropIndicatorClass="rounded-(--radius) border-2 border-primary bg-primary/10"
            drawerClass="bg-background border-r border-border"
            sheetClass="rounded-t-(--radius-lg) bg-background"
            backdropClass="bg-black/30"
            renderTab={(tab) => (
              // One view inside the tab: a row holding the title and the close button.
              <View class="flex-row items-center gap-1.5">
                <Text class="text-[13px] text-muted-foreground group-selected:text-foreground">{titles[tab.panel]}</Text>
                {tab.closable && desktop ? (
                  <Button
                    onPress={() => area.closePanel(tab.panel)}
                    accessibilityLabel={`Close ${titles[tab.panel]}`}
                    class="rounded-sm px-1 hover:bg-muted active:opacity-70"
                    focusStyle={focusRing()}
                  >
                    <Text class="text-xs text-muted-foreground">×</Text>
                  </Button>
                ) : null}
              </View>
            )}
            renderDragPreview={(tab) => (
              <View class="rounded-(--radius) border border-border bg-background px-3 py-1.5 shadow-md">
                <Text class="text-[13px] text-foreground">{titles[tab.panel]}</Text>
              </View>
            )}
            renderPanel={(panel) => (
              <View class="flex-1 gap-1 p-3">
                {(lines[panel.id] ?? []).map((line) => (
                  <Text class="font-mono text-xs text-foreground">{line || " "}</Text>
                ))}
              </View>
            )}
            renderEmpty={() => (
              <View class="flex-1 items-center justify-center">
                <Text class="text-sm text-muted-foreground">Every panel is closed</Text>
              </View>
            )}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
