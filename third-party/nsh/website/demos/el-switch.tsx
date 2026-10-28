import { mount, signal, Text, View } from "nsh";
import { Switch } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, Panel, size, Split, ui } from "./palette";

// The parts: geometry and motion in classes (`checked:` moves the thumb,
// `disabled:` dims the row, both following the switch), colors from the
// palette by the value the app owns. A pointer gets the compact size; the
// pointer's hover and the keyboard's focus ring come from the palette, and
// the thumb and track stay still with reduced motion.
const row = `flex-row-reverse items-center justify-between gap-3 ${desktop ? "px-3 py-2" : "px-4 py-3"} active:opacity-70 disabled:opacity-40`;
const track = `${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`;
const thumb = desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5";

function Setting(props: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (e: { checked: boolean }) => void }) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onChange}
      class={row}
      hoverStyle={props.disabled ? undefined : hoverFill()}
      focusStyle={focusRing()}
      trackClass={track}
      trackStyle={props.checked ? ui().accentFill : ui().inset}
      thumbClass={thumb}
      thumbStyle={props.checked ? { backgroundColor: ui().onAccent } : ui().raised}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
        <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
      </View>
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
  const line = () => <View style={{ height: 1, marginLeft: desktop ? 12 : 16, backgroundColor: ui().line }} />;
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
        <View style={{ ...ui().card, borderRadius: 16, overflow: "hidden" }}>
          <Setting label="Wi-Fi" detail={wifi() ? "Connected to Studio" : "Off"} checked={wifi()} onChange={change("Wi-Fi", wifi)} />
          {line()}
          <Setting
            label="Ask to join networks"
            detail={wifi() ? "Known networks join on their own" : "Turn on Wi-Fi first"}
            checked={ask()}
            disabled={!wifi()}
            onChange={change("Ask to join", ask)}
          />
          {line()}
          <Setting label="Bluetooth" detail={bluetooth() ? "Discoverable as “Desk”" : "Off"} checked={bluetooth()} onChange={change("Bluetooth", bluetooth)} />
        </View>
      </Split>
    </View>
  );
}

mount(App);
