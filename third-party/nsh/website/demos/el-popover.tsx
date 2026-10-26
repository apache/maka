import { mount, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { button, buttonText, desktop, Inspector, Log, Segmented, Stage, ui, wide } from "./palette";

type Placement = "top" | "bottom" | "left" | "right";

function App() {
  const placement = signal<Placement>("bottom");
  const offset = signal(8);
  const events = signal<string[]>([]);
  const presses = signal(0);
  const placements = () => (
    <Segmented label="placement" options={["top", "bottom", "left", "right"] as Placement[]} value={placement()} onChange={(v) => placement.set(v)} />
  );
  const offsets = () => <Segmented label="offset" options={[0, 8, 16]} value={offset()} onChange={(v) => offset.set(v)} />;
  const popover = () => (
    <Popover
      placement={placement()}
      offset={offset()}
      margin={12}
      popupClass="w-56 gap-2 rounded-xl p-4"
      popupStyle={ui().card}
      onOpenChange={(open, reason) => events.set([`${open ? "opened" : "closed"} · ${reason}`, ...events()].slice(0, 4))}
      trigger={
        <View {...button("accent")}>
          <Text style={buttonText("accent")}>Order #1024</Text>
        </View>
      }
    >
      <Text style={{ fontSize: 15, fontWeight: "600", color: ui().text }}>Shipped yesterday</Text>
      <Text style={{ fontSize: 13, color: ui().muted }}>Arriving Friday. The trigger, a press outside and Escape close this.</Text>
      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ui().up }} />
        <Text style={{ fontSize: 12, color: ui().up }}>In transit</Text>
      </View>
    </Popover>
  );
  const count = () => (
    <View
      onPress={() => presses.update((n) => n + 1)}
      {...button("secondary", { align: "center" })}
    >
      <Text style={buttonText()}>Count · pressed {presses()}×</Text>
    </View>
  );
  const log = () => <Log title="onOpenChange(open, reason)" lines={events()} minHeight={92} />;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>popover</Text>
      <Text style={{ color: ui().muted }}>
        {desktop
          ? "Open it, then click “Count” below: one click closes it and presses the button"
          : "Open it, then tap “Count” below: the tap only closes it"}
      </Text>

      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <Stage gap={24}>
              <View style={{ height: 280, alignItems: "center", justifyContent: "center" }}>{popover()}</View>
              {count()}
            </Stage>
            <Inspector>
              {placements()}
              {offsets()}
              {log()}
            </Inspector>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 3 }}>{placements()}</View>
              <View style={{ flex: 2 }}>{offsets()}</View>
            </View>
            <View style={{ flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center" }}>{popover()}</View>
            {count()}
            {log()}
          </>
        )
      }
    </View>
  );
}

mount(App);
