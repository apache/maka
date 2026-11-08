import { mount, signal, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { desktop, Log, Split, ui, controlSize, RadioRing, RowDivider, RowLabel, sectionSurface, segmentedLook, listRow } from "./palette";

const plans = [
  { id: "starter", label: "Starter", detail: "1 project · 5 GB", price: "Free" },
  { id: "pro", label: "Pro", detail: "Unlimited projects · 100 GB", price: "$12" },
  { id: "team", label: "Team", detail: "Shared workspace · 1 TB", price: "$40", locked: true },
];
const cycles = ["Monthly", "Yearly"];

/** A segmented control's look: the group is the track, `thumbStyle` raises the checked radio. */
const segments = segmentedLook();

function App() {
  const plan = signal("pro");
  const cycle = signal("Monthly");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>radio</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click an option, or Tab to a group and move with the arrow keys" : "Tap an option: its label checks it too"}
      </Text>

      <Split gap={14} inspector={<Log title={`onChange({ checked }) · ${plan()}, ${cycle()}`} lines={events()} minHeight={76} />}>
        {/* A segmented choice: each radio is a segment, `checkedStyle` raises the checked one. */}
        <RadioGroup style={segments.style}>
          <Each of={cycles}>
            {(c) => (
              <Radio
                checked={cycle() === c()}
                onChange={({ checked }) => {
                  cycle.set(c());
                  log(`${c()} → ${checked}`);
                }}
                {...segments.segment({ selected: () => cycle() === c() })}
                checkedStyle={segments.thumbStyle}
              >
                <Text style={segments.label(cycle() === c())}>{c()}</Text>
              </Radio>
            )}
          </Each>
        </RadioGroup>

        {/* A list of options, each row the radio: a ring that lights up, its dot growing in (in place with reduced motion). */}
        <RadioGroup style={sectionSurface({ padded: true })}>
          <Each of={plans}>
            {(item, i) => (
              <Radio
                checked={plan() === item().id}
                disabled={item().locked}
                onChange={({ checked }) => {
                  plan.set(item().id);
                  log(`${item().label} → ${checked}`);
                }}
                class="group"
                {...listRow({ first: i() === 0, disabled: item().locked })}
              >
                <RowDivider show={i() > 0} />
                <RadioRing on={plan() === item().id} />
                <RowLabel label={item().label} detail={item().detail} />
                <Text style={{ fontSize: controlSize.label, fontVariant: ["tabular-nums"], color: plan() === item().id ? ui().text : ui().muted }}>{item().price}</Text>
              </Radio>
            )}
          </Each>
        </RadioGroup>
      </Split>
    </View>
  );
}

mount(App);
