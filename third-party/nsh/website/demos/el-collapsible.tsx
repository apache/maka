import { type JSX, mount, signal, Text, View } from "nsh";
import { Collapsible, Switch } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, Panel, size, Split, ui } from "./palette";

// Each section: a summary row, the app's trigger (it says whether it is
// expanded to screen readers), and details the collapsible reveals while the
// app has it open: its height springs open and shut (`reveal`), and the
// sections below move with it. The chevron turns with a transition of the
// app's. One inset per card, leading and trailing: the summary's chevron
// lane is as wide as the turned chevron, so it ends where the values below
// it end.
// The pointer's hover and the keyboard's focus ring come from the palette;
// the reveal, the chevron and the switch stay still with reduced motion.
const pad = desktop ? "px-3" : "px-4";

function Section(props: { label: string; detail: string; open: boolean; onToggle: () => void; content: JSX.Element }) {
  return (
    <Collapsible open={props.open} reveal content={props.content}>
      <View
        role="button"
        accessibilityState={{ expanded: props.open }}
        onPress={props.onToggle}
        hoverStyle={hoverFill()}
        focusStyle={focusRing()}
        class={`flex-row items-center gap-3 ${pad} active:opacity-70`}
        style={{ minHeight: size.row + 8 }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
          <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
        </View>
        <View class="h-5 w-2 items-center justify-center transition-transform duration-150 motion-reduce:transition-none" style={{ rotate: props.open ? "90deg" : "0deg" }}>
          <Text style={{ fontSize: 18, color: ui().muted }}>›</Text>
        </View>
      </View>
    </Collapsible>
  );
}

const USAGE: [string, string][] = [
  ["Photos", "120 GB"],
  ["Apps", "54 GB"],
  ["System", "38 GB"],
];

function App() {
  const storage = signal(true);
  const advanced = signal(false);
  const originals = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  const toggle = (name: string, open: { (): boolean; set: (v: boolean) => void }) => () => {
    open.set(!open());
    log(`${name} → ${open() ? "open" : "closed"}`);
  };
  const line = () => <View style={{ height: 1, marginLeft: desktop ? 12 : 16, backgroundColor: ui().line }} />;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>collapsible</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click a summary, or Tab to it and press Space" : "Tap a summary to show its details"}</Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="open">
              <Text style={{ fontSize: 13, color: ui().text }}>
                Storage {storage() ? "open" : "closed"} · Advanced {advanced() ? "open" : "closed"}
              </Text>
              <Text style={{ fontSize: 12, color: ui().muted }}>Keep originals {originals() ? "on" : "off"}: kept while collapsed</Text>
            </Panel>
            <Log title="onPress (trigger) → open" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, overflow: "hidden" }}>
          <Section
            label="Storage"
            detail="212 GB of 256 GB used"
            open={storage()}
            onToggle={toggle("Storage", storage)}
            content={
              <View class={`${pad} pb-2`}>
                {USAGE.map(([name, value]) => (
                  <View class="flex-row items-center" style={{ minHeight: size.rowSm }}>
                    <Text style={{ flex: 1, fontSize: size.label, color: ui().muted }}>{name}</Text>
                    <Text style={{ fontSize: size.label, color: ui().muted, fontVariant: ["tabular-nums"] }}>{value}</Text>
                  </View>
                ))}
              </View>
            }
          />
          {line()}
          <Section
            label="Advanced"
            detail="Options most people leave alone"
            open={advanced()}
            onToggle={toggle("Advanced", advanced)}
            content={
              <Switch
                checked={originals()}
                onChange={({ checked }) => {
                  originals.set(checked);
                }}
                class={`flex-row-reverse items-center justify-between gap-3 ${pad} pb-3 active:opacity-70`}
                hoverStyle={hoverFill()}
                focusStyle={focusRing()}
                trackClass={`${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`}
                trackStyle={originals() ? ui().accentFill : ui().inset}
                thumbClass={desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5"}
                thumbStyle={originals() ? { backgroundColor: ui().onAccent } : ui().raised}
              >
                <Text style={{ flex: 1, fontSize: size.label, color: ui().text }}>Keep originals</Text>
              </Switch>
            }
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
