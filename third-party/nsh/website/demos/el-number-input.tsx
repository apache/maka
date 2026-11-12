import { type JSX, mount, signal, Text, View } from "nsh";
import { NumberInput, Switch } from "nsh/base";
import { desktop, Log, Panel, Split, switchLook, ui, plainRow, RowLabel, sectionSurface, listRow, controlSize, numberInputClasses, numberInputSteps, numberInputText } from "./palette";

// The look is the shared number input look: one recessed well
// (`numberInputClasses.frame`: a stronger edge under the pointer, the
// fields' accent focus edge while its field edits), − and + or a pair of
// chevrons (`numberInputSteps`) that light up under the pointer and while
// pressed and fade where a step would do nothing (at `min` / `max`) or while
// the input is disabled, and the field's text (`numberInputText`). A pointer
// gets the compact sizes. The price stacks its buttons on the right with
// its currency beside the field.
const split = () => numberInputSteps("split", desktop ? "w-8" : "w-11", desktop ? 14 : 16);
const centered = () => ({ ...numberInputText(), textAlign: "center" as const });

/** A setting: its label and detail, the field at the trailing edge, a hairline above all but the first (`plainRow`). */
// The field: room for "Not set" between a touch screen's 44-point steppers.
function Row(props: { label: string; detail: string; first?: boolean; children: JSX.Element }) {
  return (
    <View style={plainRow({ first: props.first })}>
      <RowLabel label={props.label} detail={props.detail} />
      <View style={{ width: desktop ? 132 : 176 }}>{props.children}</View>
    </View>
  );
}

const show = (v: number | null) => (v === null ? "null" : `${v}`);

function App() {
  const tickets = signal<number | null>(2);
  const price = signal<number | null>(19.95);
  const temperature = signal<number | null>(null);
  const disabled = signal(false);
  const events = signal<string[]>([]);
  const change = (name: string, value: { set: (v: number | null) => void }) => ({ value: next }: { value: number | null }) => {
    value.set(next);
    events.set([`${name} → ${show(next)}`, ...events()].slice(0, 5));
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>number-input</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Type a number, click − and +, or press ↑ ↓ (Page Up / Down: ten steps) in the field" : "Type a number, or tap − and +"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value · disabled">
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                tickets {show(tickets())} · price {show(price())} · °C {show(temperature())}
                {disabled() ? " (disabled)" : ""}
              </Text>
              <Switch
                checked={disabled()}
                onChange={({ checked }) => disabled.set(checked)}
                {...listRow({ first: true, style: { flexDirection: "row-reverse" } })}
                {...switchLook(() => disabled())}
              >
                <RowLabel label="Disabled" />
              </Switch>
            </Panel>
            <Log title="onChange({ value })" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={sectionSurface({ padded: true })}>
          <Row first label="Tickets" detail="1 to 10">
            <NumberInput
              value={tickets()}
              onChange={change("tickets", tickets)}
              min={1}
              max={10}
              accessibilityLabel="Tickets"
              disabled={disabled()}
              class={numberInputClasses.frame}
              inputStyle={centered()}
              {...split()}
            />
          </Row>
          <Row label="Price" detail="Steps of 0.05">
            <NumberInput
              value={price()}
              onChange={change("price", price)}
              min={0}
              step={0.05}
              accessibilityLabel="Price"
              disabled={disabled()}
              class={numberInputClasses.frame}
              inputStyle={numberInputText()}
              {...numberInputSteps("pair", desktop ? "w-6" : "w-9", desktop ? 14 : 16)}
              suffix={<Text style={{ alignSelf: "center", paddingRight: 8, fontSize: controlSize.detail, color: ui().muted }}>USD</Text>}
            />
          </Row>
          <Row label="Temperature" detail="−20 to 40 °C, halves">
            <NumberInput
              value={temperature()}
              onChange={change("temperature", temperature)}
              min={-20}
              max={40}
              step={0.5}
              placeholder="Not set"
              accessibilityLabel="Temperature"
              disabled={disabled()}
              class={numberInputClasses.frame}
              inputStyle={centered()}
              {...split()}
            />
          </Row>
        </View>
      </Split>
    </View>
  );
}

mount(App);
