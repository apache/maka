import { signal, Text, untracked, View } from "nsh";
import { Button, DockArea, type DockAreaLayout, type DockAreaRef } from "nsh/base";
import { platform, windowSize } from "nsh";
import { Button as GalleryButton, colors, desktop, dockClasses, DockDragPreview, DockTab, dockTabCloseClass, hint, IconTile, radius, terminal, ToggleButton } from "../ui";

// `nsh/base`'s `DockArea` owns the workspace's behavior: tab drags into
// another group, to a group's edge (a new split) or along a tab bar, all
// run natively; the splits' and docks' handles; selection, closing and
// what may move. The layout is the app's data: the area reports every edit
// as the whole new layout and the app passes it back. Each panel's content
// is the app's too, rendered once per key, so it keeps its state wherever
// the panel moves. The look is the gallery's: the workspace sits in a card
// on its inset surface, tabs and docks in the theme's classes.

/** The panels, by key: their titles. */
const TITLES: Record<string, string> = {
  files: "Files",
  readme: "README.md",
  main: "main.rs",
  preview: "Preview",
  terminal: "Terminal",
};
const title = (panel: string) => TITLES[panel] ?? panel;

/** The docks' names, by placement. */
const DOCKS: Record<string, string> = { left: "Files", bottom: "Terminal" };
/** The docks' regions, which their headers name (their tabs name the panels). */
const REGIONS: Record<string, string> = { left: "Sidebar", bottom: "Panel" };

type DockNode = DockAreaLayout["center"];
type DockRegion = NonNullable<DockAreaLayout["left"]>;

/** The workspace at first: two editor groups side by side, the files on
 * the left and a terminal under them. */
function initial(): DockAreaLayout {
  return {
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: ["readme", "main"], activeIndex: 1 },
        { type: "tabs", panels: ["preview"] },
      ],
      sizes: [300, null],
    },
    left: { layout: { type: "tabs", panels: ["files"] }, size: 200 },
    bottom: { layout: { type: "tabs", panels: ["terminal"] }, size: 160 },
  };
}

/** A layout in words: a group's tabs by name (`README.md, main.rs`), the
 * groups of a split side by side apart by `|`, stacked by `/`, a split
 * inside another in parentheses. */
function describe(node: DockNode, nested = false): string {
  if (node.type === "tabs") return node.panels.map(title).join(", ");
  const groups = node.children.map((child) => describe(child, true)).join(node.axis === "horizontal" ? " | " : " / ");
  return nested ? `(${groups})` : groups;
}

function describeDock(name: string, dock: DockRegion | null | undefined): string {
  if (!dock) return `${name} dock: none`;
  return `${name} dock: ${describe(dock.layout)}, ${Math.round(dock.size ?? 0)} pt, ${dock.open === false ? "closed" : "open"}`;
}

/** The size of the center's first group, when the center is a split. */
function firstSlot(node: DockNode): string {
  if (node.type !== "split") return "the whole center";
  const size = node.sizes?.[0];
  return size == null ? "auto" : `${Math.round(size)} pt`;
}

/** The lines of an editor's file. */
const SOURCES: Record<string, string[]> = {
  main: ["use hopper::App;", "", "fn main() {", "    hopper::run(App::default());", "}"],
  readme: ["# Hopper", "", "A dockable workspace: drag a tab", "to another group or to an edge."],
};

/** An editor: a count of its edits, which survives every move, over its
 * file's lines. */
function Editor(props: { panel: string }) {
  const edits = signal(0);
  return (
    <View class="flex-1 gap-4 p-4">
      <View class="flex-row items-center gap-3">
        <GalleryButton label="Edit" icon="plus" variant="secondary" size="small" accessibilityLabel={`Edit ${title(props.panel)}`} onPress={() => edits.set(edits() + 1)} />
        <Text class="text-sm tabular-nums text-muted-foreground">{`${title(props.panel)}: ${edits()} ${edits() === 1 ? "edit" : "edits"}`}</Text>
      </View>
      <View class="gap-1">
        {(SOURCES[props.panel] ?? []).map((line, i) => (
          <View class="flex-row gap-3">
            <Text class="w-4 text-right font-mono text-xs tabular-nums text-faint">{String(i + 1)}</Text>
            {/* One line each, as an editor's: code never wraps. */}
            <Text class="flex-1 font-mono text-xs text-code" style={{ numberOfLines: 1 }}>{line}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The files' tree: a folder and its files, then the manifest. */
const FILES = [
  { name: "src/", depth: 0, folder: true },
  { name: "src/app.rs", depth: 1 },
  { name: "src/lib.rs", depth: 1 },
  { name: "Cargo.toml", depth: 0 },
];

/** What a panel shows, by key. */
function Panel(props: { panel: string }) {
  switch (props.panel) {
    case "readme":
    case "main":
      return <Editor panel={props.panel} />;
    case "files":
      return (
        <View class="flex-1 gap-0.5 p-2">
          {FILES.map((file) => (
            <View class="h-7 flex-row items-center gap-2 rounded-md pr-2 hover:bg-hover" style={{ paddingLeft: 8 + file.depth * 14 }}>
              <View class="size-1.5 rounded-full" style={{ backgroundColor: file.folder ? colors.accent : colors.faint }} />
              <Text class="font-mono text-xs text-foreground">{file.name}</Text>
            </View>
          ))}
        </View>
      );
    case "preview":
      return (
        <View class="flex-1 items-center justify-center gap-3 p-4">
          <IconTile name="spark" tint={colors.accent} />
          <View class="items-center gap-0.5">
            <Text class="text-sm font-semibold text-foreground">Live preview</Text>
            <Text class="text-xs text-muted-foreground">Follows the editor beside it</Text>
          </View>
        </View>
      );
    default:
      return (
        <View class="flex-1 gap-1 p-3">
          <Text class="font-mono text-xs text-foreground">$ cargo run</Text>
          <Text class="font-mono text-xs text-muted-foreground">   Compiling hopper v0.1.0</Text>
          <Text class="font-mono text-xs text-brand">Finished in 1.92s</Text>
        </View>
      );
  }
}

/** A toolbar control: a small secondary button (`buttonLook`); one that
 * toggles is the gallery's `ToggleButton`, its dot lit while on. */
function Tool(props: { label: string; name: string; onPress: () => void; on?: boolean; toggle?: boolean }) {
  return (
    <If when={props.toggle} else={<GalleryButton label={props.name} accessibilityLabel={props.label} variant="secondary" size="small" onPress={props.onPress} />}>
      <ToggleButton label={props.name} accessibilityLabel={props.label} on={!!props.on} onPress={props.onPress} />
    </If>
  );
}

/**
 * A label and a value in the status bar under the workspace (`"Zoomed: none"`): every label muted and every value in
 * the text color, so the line reads the same wherever it wraps.
 */
function Status(props: { children: string }) {
  const at = () => props.children.indexOf(": ");
  return (
    <Text class="text-xs tabular-nums text-muted-foreground">
      {at() < 0 ? "" : props.children.slice(0, at() + 2)}
      <Text style={{ color: colors.text }}>{at() < 0 ? props.children : props.children.slice(at() + 2)}</Text>
    </Text>
  );
}

/**
 * Dock: `nsh/base`'s `DockArea`, editor tabs in a center split, files in a
 * left dock and a terminal in a bottom dock; tabs dragged between groups
 * and to their edges, closed, the docks toggled and resized. Narrower than
 * 600 pt it shows one group at a time and presents a dock at a time, as a
 * drawer or a sheet over the editors, leaving the layout's `open` as it is.
 * The workspace fills the pane, in a card with the layout's state below it.
 */
export function Dock() {
  const layout = signal<DockAreaLayout>(initial());
  const locked = signal(false);
  const last = signal("—");
  // Whether the editors' tabs offer to close them: `panels` says which
  // may close, and `renderTab` shows a close button where `closable` is.
  const closing = signal(true);
  // The zoomed panel's group fills the area (`onZoomChange`). The toolbar
  // zooms the group of the tab shown last: each tab tells its group.
  const zoomed = signal<string | null>(null);
  let current = "main";
  const groups = new Map<string, number>();
  // The docks that show (`onDockOpenChange`): open ones in the full
  // presentation, none at first at compact width, where the area is less
  // than 600 wide (a phone's window).
  const wide = untracked(windowSize).width >= 600;
  const shown = signal<Record<string, boolean>>({ left: wide, bottom: wide });
  let area!: DockAreaRef;
  const pointer = platform.desktop;

  return (
    <View class="flex-1 bg-background" style={{ padding: desktop() ? 24 : 16, gap: desktop() ? 16 : 12 }}>
      <View class="flex-row flex-wrap items-center gap-2">
        <Tool label="Toggle files" name="Files" toggle on={shown().left} onPress={() => area.toggleDock("left")} />
        <Tool label="Toggle terminal" name="Terminal" toggle on={shown().bottom} onPress={() => area.toggleDock("bottom")} />
        <Tool label="Lock the layout" name="Lock" toggle on={locked()} onPress={() => locked.set(!locked())} />
        <Tool label="Show close buttons" name="Close" toggle on={closing()} onPress={() => closing.set(!closing())} />
        <Tool
          label="Zoom the group"
          name="Zoom"
          toggle
          on={zoomed() !== null}
          onPress={() => area.toggleZoom(zoomed() === null ? (groups.get(current) ?? null) : null)}
        />
        <Tool label="Reset the layout" name="Reset" onPress={() => layout.set(initial())} />
        <Text class="min-w-40 flex-1 text-right text-[13px] text-muted-foreground">
          {hint("Hold a tab to reorder it", "Drag a tab onto another group, or to a group's edge to split it")}
        </Text>
      </View>
      {/* One frame: the workspace and its status bar under a hairline. */}
      <View class="flex-1 overflow-hidden border border-border bg-card" style={{ borderRadius: radius.card, borderCurve: "continuous" }}>
        <View class="flex-1 bg-inset">
          <DockArea
            ref={area}
            class="flex-1"
            layout={layout()}
            onLayoutChange={({ layout: next }) => layout.set(next)}
            onPanelRemove={({ panel }) => last.set(`Closed ${title(panel)}`)}
            onPanelActiveChange={({ panel, active }) => {
              if (!active) return;
              current = panel;
              last.set(`Showing ${title(panel)}`);
            }}
            onZoomChange={({ panel }) => zoomed.set(panel)}
            panels={closing() ? [] : Object.keys(TITLES).map((id) => ({ id, closable: false }))}
            onDockOpenChange={({ placement, open }) => shown.set({ ...shown(), [placement]: open })}
            locked={locked()}
            // The parts in the shared look: groups and docks on the inset, the
            // handles' hairlines that stay as they are, their thumbs, pills
            // that grow in under the pointer and further while dragged
            // (gpui-component's), the drop target in the brand color.
            {...dockClasses}
            handleAccessibilityLabel="Resize"
            renderTab={(tab) => {
              groups.set(tab.panel, tab.group);
              return (
              // Sized to its title (`DockTab`): the shown tab is lit and
              // underlined in citrus (the sidebar's selection). With a pointer,
              // the close button fades in over the tab's end while the pointer
              // is on it; a touch screen keeps it beside the shown tab's title.
              <DockTab testID={`tab-${tab.panel}`} title={title(tab.panel)} active={tab.active}>
                <If when={tab.closable && (pointer || tab.active)}>
                  <Button onPress={() => area.closePanel(tab.panel)} accessibilityLabel={`Close ${title(tab.panel)}`} class={dockTabCloseClass}>
                    <Text class="text-[13px] text-muted-foreground">×</Text>
                  </Button>
                </If>
              </DockTab>
              );
            }}
            renderDock={(dock) => (
              <View class="h-8 flex-row items-center border-b border-line pl-3 pr-1">
                {/* The region's name: its tab already names the panel in it. */}
                <Text class="flex-1 text-xs font-medium text-muted-foreground">{REGIONS[dock.placement] ?? dock.placement}</Text>
                <Button
                  // Toggled: at compact width that dismisses the drawer, in
                  // the full presentation it closes the open dock.
                  onPress={() => area.toggleDock(dock.placement)}
                  accessibilityLabel={`Hide ${DOCKS[dock.placement] ?? dock.placement}`}
                  class="rounded-md px-2 py-0.5 hover:bg-hover active:opacity-70"
                >
                  <Text class="text-xs font-medium text-muted-foreground">Hide</Text>
                </Button>
              </View>
            )}
            renderDragPreview={(tab) => <DockDragPreview title={title(tab.panel)} />}
            renderPanel={(panel) => <Panel panel={panel.id} />}
            renderEmpty={() => (
              <View class="flex-1 items-center justify-center gap-1">
                <Text class="text-sm font-semibold text-foreground">Every editor is closed</Text>
                <Text class="text-xs text-muted-foreground">Reset brings them back</Text>
              </View>
            )}
          />
        </View>
        {/* Two columns apart in a terminal (gap-x-6, 24 pt), so each status reads on its own. */}
        <View class={`flex-row flex-wrap ${terminal ? "gap-x-6 px-2.5 pb-1 pt-0.5" : "gap-x-5 border-t border-line px-3 py-2"} gap-y-1`}>
          <Status>{`Center: ${describe(layout().center)}`}</Status>
          <Status>{`First group: ${firstSlot(layout().center)}`}</Status>
          <Status>{describeDock("Left", layout().left)}</Status>
          <Status>{describeDock("Bottom", layout().bottom)}</Status>
          <Status>{`Showing docks: ${["left", "bottom"].filter((p) => shown()[p]).map((p) => DOCKS[p]).join(", ") || "none"}`}</Status>
          <Status>{`Zoomed: ${zoomed() === null ? "none" : title(zoomed()!)}`}</Status>
          <If when={last() !== "—"}>
            <Status>{`Last event: ${last()}`}</Status>
          </If>
        </View>
      </View>
    </View>
  );
}
