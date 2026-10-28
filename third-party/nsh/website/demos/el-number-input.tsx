import { type JSX, mount, signal, Text, View } from "nsh";
import { NumberInput, Switch } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, Panel, size, Split, ui } from "./palette";

// The parts: geometry and states in classes, colors from the theme's
// tokens. The input is one recessed well (a stronger border under the
// pointer, the focus ring while its field edits: `focus-within:`); the
// buttons light up under the pointer and while pressed (a transition the
// reduced-motion setting stills) and fade where a step would do nothing (at
// `min` / `max`) or while the input is disabled, without their hover. A
// pointer gets the compact sizes. The price stacks its buttons on the right
// with its currency beside the field.
const frame = [
  desktop ? "h-8 rounded-lg" : "h-11 rounded-xl",
  "flex-row items-stretch overflow-hidden border border-input bg-field",
  "enabled:hover:border-faint focus-within:outline-2 focus-within:outline-info disabled:opacity-50",
].join(" ");
const stepButton = [
  desktop ? "w-8" : "w-11",
  "items-center justify-center transition-colors duration-100 motion-reduce:transition-none",
  "enabled:hover:bg-accent active:bg-track disabled:opacity-35",
].join(" ");
const stackedButton = "flex-1 items-center justify-center transition-colors duration-100 motion-reduce:transition-none enabled:hover:bg-accent active:bg-track disabled:opacity-35";
const field = () => ({
  flex: 1,
  minWidth: 0,
  paddingHorizontal: desktop ? 8 : 10,
  fontSize: desktop ? 14 : 16,
  color: ui().text,
  placeholderColor: ui().faint,
  fontVariant: ["tabular-nums" as const],
});

/** A minus or a plus drawn with two bars in the text color. */
function Glyph(props: { plus?: boolean; small?: boolean }) {
  const length = props.small ? 8 : desktop ? 10 : 12;
  const bar = () => ({ position: "absolute" as const, borderRadius: 1, backgroundColor: ui().text });
  return (
    <View style={{ pointerEvents: "none", width: length, height: length }}>
      <View style={{ ...bar(), left: 0, right: 0, top: length / 2 - 0.75, height: 1.5 }} />
      {props.plus ? <View style={{ ...bar(), top: 0, bottom: 0, left: length / 2 - 0.75, width: 1.5 }} /> : null}
    </View>
  );
}

function Row(props: { label: string; detail: string; children: JSX.Element }) {
  return (
    <View class={`flex-row items-center gap-3 ${desktop ? "px-3 py-2.5" : "px-4 py-3"}`}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
        <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
      </View>
      <View style={{ width: desktop ? 148 : 168 }}>{props.children}</View>
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
  const line = () => <View style={{ height: 1, marginLeft: desktop ? 12 : 16, backgroundColor: ui().line }} />;
  const sides = () => ({
    disabled: disabled(),
    class: frame,
    inputStyle: { ...field(), textAlign: "center" as const },
    decrementButtonClass: `${stepButton} border-r border-line`,
    incrementButtonClass: `${stepButton} border-l border-line`,
    decrementButton: <Glyph />,
    incrementButton: <Glyph plus />,
  });
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
                class={`-mx-2 flex-row-reverse items-center justify-between gap-3 rounded-lg px-2 ${desktop ? "py-1" : "py-2"} active:opacity-70`}
                hoverStyle={hoverFill()}
                focusStyle={focusRing()}
                trackClass={`${desktop ? "w-9" : "w-12"} rounded-full p-0.5 transition-colors motion-reduce:transition-none`}
                trackStyle={disabled() ? ui().accentFill : ui().inset}
                thumbClass={desktop ? "size-4 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-4" : "size-5.5 rounded-full transition-transform motion-reduce:transition-none checked:translate-x-5"}
                thumbStyle={disabled() ? { backgroundColor: ui().onAccent } : ui().raised}
              >
                <Text style={{ flex: 1, fontSize: size.label, color: ui().text }}>Disabled</Text>
              </Switch>
            </Panel>
            <Log title="onChange({ value })" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, overflow: "hidden" }}>
          <Row label="Tickets" detail="1 to 10">
            <NumberInput
              value={tickets()}
              onChange={change("tickets", tickets)}
              min={1}
              max={10}
              accessibilityLabel="Tickets"
              {...sides()}
            />
          </Row>
          {line()}
          <Row label="Price" detail="Steps of 0.05">
            <NumberInput
              value={price()}
              onChange={change("price", price)}
              min={0}
              step={0.05}
              accessibilityLabel="Price"
              controlsRight
              disabled={disabled()}
              class={frame}
              inputStyle={field()}
              controlsClass={`${desktop ? "w-6" : "w-9"} border-l border-line`}
              incrementButtonClass={`${stackedButton} border-b border-line`}
              decrementButtonClass={stackedButton}
              incrementButton={<Glyph plus small />}
              decrementButton={<Glyph small />}
              suffix={<Text style={{ alignSelf: "center", paddingRight: 8, fontSize: size.detail, color: ui().muted }}>USD</Text>}
            />
          </Row>
          {line()}
          <Row label="Temperature" detail="−20 to 40 °C, halves">
            <NumberInput
              value={temperature()}
              onChange={change("temperature", temperature)}
              min={-20}
              max={40}
              step={0.5}
              placeholder="Not set"
              accessibilityLabel="Temperature"
              {...sides()}
            />
          </Row>
        </View>
      </Split>
    </View>
  );
}

mount(App);
