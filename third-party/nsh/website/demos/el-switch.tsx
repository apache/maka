import { mount, signal, Text, View } from "nsh";
import { Switch } from "nsh/base";
import { desktop, Log, Panel, Split, switchLook, ui, listRow, RowDivider, RowLabel, sectionSurface } from "./palette";

// The track and the thumb take the shared switch look (`switchLook`): the
// knob springs across by the value the app owns, as far from the track's
// edge on as off, and lands at once with reduced motion. The row is the
// switch itself, its track at the trailing edge (`listRow`: the hover fill
// reaching past the content, the keyboard's focus ring, a press that dims,
// dimmed while disabled).
function Setting(props: { label: string; detail: string; checked: boolean; disabled?: boolean; first?: boolean; onChange: (e: { checked: boolean }) => void }) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onChange}
      {...listRow({ first: props.first, disabled: () => props.disabled, style: { flexDirection: "row-reverse" } })}
      {...switchLook(() => props.checked)}
    >
      <RowDivider show={!props.first} />
      <RowLabel label={props.label} detail={props.detail} />
    </Switch>
  );
}

function App() {
  const wifi = signal(true);
  const bluetooth = signal(false);
  const ask = signal(true);
  const events = signal<string[]>([]);
  const change = (name: string, value: { set: (v: boolean) => void }) => ({ checked }: { checked: boolean }) => {
    value.set(checked);
    events.set([`${name} → ${checked}`, ...events()].slice(0, 3));
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>switch</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click a row, or Tab to a switch and press Space" : "Tap a row: the label toggles it too"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="checked · disabled">
              <Text style={{ fontSize: 13, color: ui().text }}>
                Wi-Fi {wifi() ? "on" : "off"} · ask {ask() ? "on" : "off"}
                {wifi() ? "" : " (disabled)"} · Bluetooth {bluetooth() ? "on" : "off"}
              </Text>
            </Panel>
            <Log title="onChange({ checked })" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={sectionSurface({ padded: true })}>
          <Setting first label="Wi-Fi" detail={wifi() ? "Connected to Studio" : "Off"} checked={wifi()} onChange={change("Wi-Fi", wifi)} />
          <Setting
            label="Ask to join networks"
            detail={wifi() ? "Known networks join on their own" : "Turn on Wi-Fi first"}
            checked={ask()}
            disabled={!wifi()}
            onChange={change("Ask to join", ask)}
          />
          <Setting label="Bluetooth" detail={bluetooth() ? "Discoverable as “Desk”" : "Off"} checked={bluetooth()} onChange={change("Bluetooth", bluetooth)} />
        </View>
      </Split>
    </View>
  );
}

mount(App);
