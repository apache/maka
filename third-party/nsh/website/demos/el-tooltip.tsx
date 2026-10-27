import { mount, signal, Text, View } from "nsh";
import { type OpenChangeReason, Tooltip } from "nsh/base";
import { button, buttonText, desktop, Inspector, Log, Panel, Stage, ui, wide } from "./palette";

/** An icon button with a hint of the app's look, above or below it. */
function Tool(props: {
  icon: string;
  label: string;
  hint: string;
  placement: "top" | "bottom";
  pinned: boolean;
  onPress: () => void;
  onOpenChange: (open: boolean, reason: OpenChangeReason) => void;
}) {
  const hovered = signal(false);
  return (
    <View style={{ alignItems: "center", gap: 6 }}>
      <View
        onPress={props.onPress}
        accessibilityLabel={props.label}
        {...button("secondary", { align: "center", style: { width: desktop ? 36 : 52, height: desktop ? 36 : 52, paddingHorizontal: 0 } })}
        tooltip={
          <Tooltip
            open={props.pinned || hovered()}
            placement={props.placement}
            offset={8}
            margin={8}
            delay={400}
            onOpenChange={(open, reason) => {
              hovered.set(open);
              props.onOpenChange(open, reason);
            }}
            style={{ backgroundColor: ui().text, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 6 }}
          >
            <Text style={{ fontSize: 13, color: ui().page }}>{props.hint}</Text>
          </Tooltip>
        }
      >
        <Text style={{ fontSize: desktop ? 17 : 22, color: ui().text }}>{props.icon}</Text>
      </View>
      <Text style={{ fontSize: 11, color: ui().faint }}>{props.placement}</Text>
    </View>
  );
}

function App() {
  const events = signal<string[]>([]);
  const pressed = signal("—");
  const pinned = signal(false);
  const log = (name: string) => (open: boolean, reason: OpenChangeReason) =>
    events.set([`${name} ${open ? "shown" : "hidden"} · ${reason}`, ...events()].slice(0, 6));
  const tools = () => (
    <>
      <Tool icon="★" label="Star" hint="Add to favorites" placement="top" pinned={pinned()} onPress={() => pressed.set("Star")} onOpenChange={log("Star")} />
      <Tool icon="↗" label="Share" hint="Share with your team" placement="bottom" pinned={pinned()} onPress={() => pressed.set("Share")} onOpenChange={log("Share")} />
      <Tool icon="✕" label="Delete" hint="Move to the trash" placement="top" pinned={pinned()} onPress={() => pressed.set("Delete")} onOpenChange={log("Delete")} />
    </>
  );
  // The `tooltip` prop of any element: a `Tooltip` with the app's look.
  const pin = () => (
    <View
      tooltip={
        <Tooltip style={{ backgroundColor: ui().text, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text style={{ fontSize: 13, color: ui().page }}>Shows every tooltip without a pointer</Text>
        </Tooltip>
      }
      onPress={() => pinned.set(!pinned())}
      {...button("secondary", { align: "center", style: wide() ? {} : { flex: 1 } })}
    >
      <Text style={buttonText()}>
        {wide() ? (pinned() ? "Unpin the tooltips" : "Pin the tooltips") : pinned() ? "Unpin" : "Pin"}
      </Text>
    </View>
  );
  const onPress = () => (
    <Panel title="onPress">
      <Text style={{ fontSize: 13, color: ui().text }}>{pressed()}</Text>
    </Panel>
  );
  const changes = () => <Log title="onOpenChange(open, reason)" lines={events()} minHeight={130} />;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>tooltip</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Rest the pointer on a button; a click still presses it" : "Tooltips follow a pointer: pin them to see them here"}
      </Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <Stage gap={40}>
              <View style={{ flexDirection: "row", justifyContent: "center", gap: 64 }}>{tools()}</View>
              {pin()}
            </Stage>
            <Inspector>
              {onPress()}
              {changes()}
            </Inspector>
          </View>
        ) : (
          <>
            <View style={{ flex: 1, minHeight: 200, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 28 }}>{tools()}</View>
            <View style={{ flexDirection: "row", gap: 8 }}>{pin()}</View>
            {onPress()}
            {changes()}
          </>
        )
      }
    </View>
  );
}

mount(App);
