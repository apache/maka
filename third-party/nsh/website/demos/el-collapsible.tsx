import { type JSX, mount, signal, Text, View } from "nsh";
import { Collapsible, Switch } from "nsh/base";
import { desktop, Log, Panel, Split, switchLook, ui, controlSize, listRow, RowDivider, RowLabel, sectionSurface, DisclosureChevron, disclosureTriggerLook } from "./palette";

// Each section: a summary row, the app's trigger (it says whether it is
// expanded to screen readers), and details the collapsible reveals while the
// app has it open: its height springs open and shut (`reveal`), and the
// sections below move with it. The summary is a shared row (`listRow`,
// through `disclosureTriggerLook`: the hover fill reaching past the
// content, the keyboard's focus ring, a press that dims); its chevron
// (`DisclosureChevron`) turns in a lane as wide as its stroke, so it ends
// where the values below it end. The reveal, the chevron and the switch
// stay still with reduced motion.
function Section(props: { label: string; detail: string; open: boolean; first?: boolean; onToggle: () => void; content: JSX.Element }) {
  return (
    <Collapsible open={props.open} reveal content={props.content}>
      <View role="button" accessibilityState={{ expanded: props.open }} onPress={props.onToggle} {...disclosureTriggerLook({ first: props.first })}>
        <RowDivider show={!props.first} />
        <RowLabel label={props.label} detail={props.detail} />
        <DisclosureChevron open={props.open} />
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
        <View style={sectionSurface({ padded: true })}>
          <Section
            first
            label="Storage"
            detail="212 GB of 256 GB used"
            open={storage()}
            onToggle={toggle("Storage", storage)}
            content={
              <View style={{ paddingStart: controlSize.gap, paddingBottom: controlSize.padding }}>
                {USAGE.map(([name, value]) => (
                  <View style={{ flexDirection: "row", alignItems: "center", minHeight: controlSize.line }}>
                    <Text style={{ flex: 1, fontSize: controlSize.label, color: ui().muted }}>{name}</Text>
                    <Text style={{ fontSize: controlSize.label, color: ui().muted, fontVariant: ["tabular-nums"] }}>{value}</Text>
                  </View>
                ))}
              </View>
            }
          />
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
                {...listRow({ start: controlSize.gap, style: { flexDirection: "row-reverse" } })}
                {...switchLook(() => originals())}
              >
                <RowDivider show />
                <RowLabel label="Keep originals" detail={originals() ? "Edits are saved as copies" : "Edits replace the photo"} />
              </Switch>
            }
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
