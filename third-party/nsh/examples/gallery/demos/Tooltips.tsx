import { keymap, signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import type { LucideIconName } from "../icons";
import { Badge, Button, Caption, Card, colors, createPresence, DemoPage, type PopupSide, Tip } from "../ui";
import { Avatar, createEvents, pointer, Trigger } from "./OverlayUi";

type Tool = { id: string; icon: LucideIconName; label: string; key: string; hint: string };

const tools: Tool[] = [
  { id: "move", icon: "hand", label: "Move", key: "v", hint: "Drag to move what is selected" },
  { id: "text", icon: "type", label: "Text", key: "t", hint: "Click to add a text box" },
  { id: "pen", icon: "pencil", label: "Pen", key: "p", hint: "Draw a path, point by point" },
  { id: "image", icon: "image", label: "Image", key: "i", hint: "Place a picture" },
  { id: "comment", icon: "message-circle", label: "Comment", key: "c", hint: "Leave a note for the team" },
];

const reviewers = ["Mira Chen", "Ravi Patel", "Ana Silva"];

/** The thin line between a toolbar's groups. */
function Divider() {
  return <View style={{ width: 1, height: pointer ? 16 : 22, marginHorizontal: 4, backgroundColor: colors.line }} />;
}

/**
 * Tooltips of `nsh/base` where an app puts them: on a toolbar's icon
 * buttons, with their shortcuts; shown at once, after the usual half
 * second or later; on each side of their element; with more than a line in
 * them; and one the app opens itself, as touch screens need. Each comes in
 * from its side (`popIn`); on touch screens only the app's shows.
 */
export function Tooltips() {
  const { log, Events } = createEvents(pointer ? "Rest the pointer on a button" : "Pin the tooltip");

  function Toolbar() {
    const tool = signal("move");
    const history = signal<string[]>([]);
    const undone = signal<string[]>([]);
    const pick = (id: string) => {
      if (id === tool()) return;
      history.set([...history(), tool()]);
      undone.set([]);
      tool.set(id);
      log(`tool ${id}`);
    };
    const undo = () => {
      const last = history().at(-1);
      if (last === undefined) return;
      history.set(history().slice(0, -1));
      undone.set([...undone(), tool()]);
      tool.set(last);
    };
    const redo = () => {
      const next = undone().at(-1);
      if (next === undefined) return;
      undone.set(undone().slice(0, -1));
      history.set([...history(), tool()]);
      tool.set(next);
    };
    // The keys the tooltips show work while the demo does.
    keymap.bind({
      ...Object.fromEntries(tools.map((t) => [t.key, () => pick(t.id)])),
      "mod+z": undo,
      "mod+shift+z": redo,
    });
    const key = (k: string) => (pointer ? keymap.label(k) : undefined);
    const current = () => tools.find((t) => t.id === tool())!;
    return (
      <Card icon="tooltip" title="On a toolbar" subtitle={pointer ? "Rest the pointer on a tool; its key works too" : "Touch screens show none: the names are the buttons' labels"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", padding: 3, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inset }}>
          <Each of={tools}>
            {(t) => (
              <Trigger
                icon={t().icon}
                variant="ghost"
                open={tool() === t().id}
                ink={tool() === t().id ? colors.text : colors.muted}
                accessibilityLabel={t().label}
                tip={<Tip label={t().label} shortcut={key(t().key)} placement="bottom" />}
                onPress={() => pick(t().id)}
              />
            )}
          </Each>
          <Divider />
          <Trigger icon="undo-2" variant="ghost" accessibilityLabel="Undo" disabled={history().length === 0} tip={<Tip label="Undo" shortcut={key("mod+z")} placement="bottom" />} onPress={undo} />
          <Trigger icon="redo-2" variant="ghost" accessibilityLabel="Redo" disabled={undone().length === 0} tip={<Tip label="Redo" shortcut={key("mod+shift+z")} placement="bottom" />} onPress={redo} />
        </View>
        <Caption label={`${current().label}: ${current().hint}`} />
      </Card>
    );
  }

  function Delays() {
    return (
      <Card icon="tooltip" title="When it shows" subtitle="The pointer rests for the tooltip's delay first">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <View tooltip={<Tip label="Shows at once" delay={0} />}>
            <Button label="Instant" variant="secondary" onPress={() => log("pressed Instant")} />
          </View>
          <View tooltip={<Tip label="After half a second" />}>
            <Button label="Default" variant="secondary" onPress={() => log("pressed Default")} />
          </View>
          <View tooltip={<Tip label="After 1.2 seconds" delay={1200} />}>
            <Button label="Patient" variant="secondary" onPress={() => log("pressed Patient")} />
          </View>
        </View>
        <Caption label="A press hides it; leaving hides it at once" />
      </Card>
    );
  }

  function Sides() {
    const side = (placement: PopupSide, icon: LucideIconName) => (
      <Trigger icon={icon} accessibilityLabel={`Tooltip ${placement}`} tip={<Tip label={`On the ${placement}`} placement={placement} delay={200} />} onPress={() => log(`pressed ${placement}`)} />
    );
    return (
      <Card icon="tooltip" title="Its side" subtitle="Each comes out of the side it is on; it flips where there is no room">
        <View style={{ alignItems: "center", gap: 6, paddingVertical: 8 }}>
          {side("top", "arrow-up")}
          <View style={{ flexDirection: "row", gap: pointer ? 46 : 60 }}>
            {side("left", "chevron-left")}
            {side("right", "chevron-right")}
          </View>
          {side("bottom", "arrow-down")}
        </View>
      </Card>
    );
  }

  function Rich() {
    const presence = createPresence("top");
    return (
      <Card icon="tooltip" title="More than a line" subtitle="Who approved, on an avatar stack">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            accessibilityLabel={`Approved by ${reviewers.join(", ")}`}
            tooltip={
              <Tooltip delay={300} onOpen={presence.show} onClose={presence.hide}>
                <View class="rounded-lg border border-border bg-popover" style={{ ...presence.style, padding: 10, gap: 8, width: 210 }}>
                  <Text class="text-xs font-semibold text-popover-foreground">Approved by 3 reviewers</Text>
                  <Each of={reviewers}>
                    {(name) => (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Avatar name={name()} size={20} />
                        <Text class="text-xs text-popover-foreground" style={{ flex: 1 }}>
                          {name()}
                        </Text>
                        <Text class="text-xs text-muted-foreground">2h ago</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </Tooltip>
            }
            style={{ flexDirection: "row" }}
          >
            <Each of={reviewers}>
              {(name, i) => (
                <View style={{ marginLeft: i() === 0 ? 0 : -8, borderRadius: 20, borderWidth: 2, borderColor: colors.surface }}>
                  <Avatar name={name()} />
                </View>
              )}
            </Each>
          </View>
          <Badge label="Approved" tone="up" />
        </View>
      </Card>
    );
  }

  function Pinned() {
    const hovered = signal(false);
    const pinned = signal(false);
    const presence = createPresence("bottom");
    return (
      <Card icon="tooltip" title="Opened by the app" subtitle="Controlled: shown while pinned, or while the pointer rests">
        <View
          tooltip={
            <Tooltip
              open={pinned() || hovered()}
              onOpenChange={({ open, reason }) => {
                hovered.set(open);
                log(`tooltip ${open ? "shown" : "hidden"} (${reason})`);
              }}
              onOpen={presence.show}
              onClose={presence.hide}
              placement="bottom"
              delay={300}
            >
              <View class="rounded-md border border-border bg-popover px-2 py-1" style={presence.style}>
                <Text class="text-xs text-popover-foreground">Shown while pinned or hovered</Text>
              </View>
            </Tooltip>
          }
          style={{ alignSelf: "flex-start" }}
        >
          <Button label={pinned() ? "Unpin the tooltip" : "Pin the tooltip"} variant="secondary" selected={pinned()} onPress={() => pinned.set(!pinned())} />
        </View>
        <Caption label="Touch screens show a tooltip only this way" />
      </Card>
    );
  }

  return <DemoPage cards={[Toolbar, Delays, Sides, Rich, Pinned, Events]} />;
}
