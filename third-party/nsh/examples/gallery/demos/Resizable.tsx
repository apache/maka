import { signal, Text, untracked, View } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { windowSize } from "nsh";
import { Button, hint, resizableHandleLook } from "../ui";

// `nsh/base`'s resizable panels own the drags (run natively, frame by
// frame, with no JS on the way), the minimums and maximums and what
// screen readers say; the sizes are the app's: a group reports them when
// a drag ends and the app passes them back as each panel's `size`. The
// look is the app's too: the handles' hairlines and thumbs are theme
// classes (`resizableHandleLook`), the line staying as it is while its thumb
// shows where to drag.

const round = (sizes: number[]) => sizes.map((s) => Math.round(s)).join(" · ");

/** A panel's title, what it does and its size now, on one line. */
function Pane(props: { title: string; detail: string; size?: string }) {
  return (
    <View class="flex-1 gap-1 p-4">
      <Text class="text-sm font-semibold text-foreground">{props.title}</Text>
      <Text class="text-xs text-muted-foreground">{props.detail}</Text>
      <If when={props.size}>
        <Text class="font-mono text-xs tabular-nums text-foreground" style={{ numberOfLines: 1 }}>{props.size}</Text>
      </If>
    </View>
  );
}

/**
 * Resizable: `ResizablePanelGroup` and `ResizablePanel` in an editor's
 * frame, a sidebar beside an editor over a console, each handle dragged
 * within the panels' ranges; the console can be hidden and comes back at
 * its size.
 */
export function Resizable() {
  // A phone leaves the editor room beside the sidebar.
  const sidebar = signal(untracked(windowSize).width < 600 ? 130 : 220);
  const consoleSize = signal(140);
  const shown = signal(true);
  const last = signal("—");

  return (
    <View class="flex-1 gap-3 bg-background p-4">
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="flex-1 text-sm text-muted-foreground">{hint("Drag a line between two panels with your finger", "Drag a line between two panels")}</Text>
        <Button
          label="Console"
          variant="secondary"
          size="small"
          selected={shown()}
          accessibilityLabel={shown() ? "Hide the console" : "Show the console"}
          onPress={() => shown.set(!shown())}
        />
      </View>
      <View class="flex-1 overflow-hidden rounded-lg border border-border bg-background">
        <ResizablePanelGroup axis="horizontal" {...resizableHandleLook("horizontal")} handleAccessibilityLabel="Resize the sidebar" onResize={({ sizes }) => last.set(`Row: ${round(sizes)}`)}>
          <ResizablePanel size={sidebar()} minSize={120} maxSize={360} onResize={({ size }) => sidebar.set(size)}>
            <View class="flex-1 bg-muted">
              <Pane title="Files" detail="120 to 360 pt" size={`${Math.round(sidebar())} pt wide`} />
            </View>
          </ResizablePanel>
          <ResizablePanel minSize={160}>
            <ResizablePanelGroup
              axis="vertical"
              {...resizableHandleLook("vertical")}
              handleAccessibilityLabel="Resize the console"
              onResize={({ sizes }) => last.set(`Column: ${round(sizes)}`)}
            >
              <ResizablePanel minSize={80}>
                <Pane title="Editor" detail="Takes the room the others leave" />
              </ResizablePanel>
              <ResizablePanel size={consoleSize()} minSize={60} visible={shown()} onResize={({ size }) => consoleSize.set(size)}>
                <View class="flex-1 bg-muted">
                  <Pane title="Console" detail="Hidden, it keeps its size" size={`${Math.round(consoleSize())} pt tall`} />
                </View>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </View>
      <Text class="font-mono text-xs text-muted-foreground">{`Last resize: ${last()}`}</Text>
    </View>
  );
}
