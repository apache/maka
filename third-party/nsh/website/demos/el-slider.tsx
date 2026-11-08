import { type JSX, mount, signal, Text, View } from "nsh";
import { Slider, type SliderValue } from "nsh/base";
import { desktop, Log, Panel, sliderFill, sliderLook, sliderValueClass, sliderValueStyle, Split, ui, controlSize, plainRow, RowLabel, sectionSurface } from "./palette";

// The look is the shared layer's `sliderLook` and `sliderFill` (BJORK UI's
// slider in the palette's tones): an 8-point rail, a fill that deepens at its
// start and fades into the thumb at the thumb, a 16 × 8 pill thumb that
// brightens under the pointer and while dragged, the keyboard's focus ring
// around the rail, and 35% when disabled. The spread holds only what never
// changes; the fill follows the value as a prop of its own. The demo shows a slider with its value column, a
// bare one, a range, a disabled one and vertical bands, each named above it.
const show = (v: SliderValue) => (typeof v === "number" ? `${v}` : `${v[0]}–${v[1]}`);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, "0")}`;
const LENGTH = 225;

/** A level: its label and value over the slider, a hairline above all but the first (`plainRow`). */
function Row(props: { label: string; value?: string; first?: boolean; children: JSX.Element }) {
  return (
    <View style={{ ...plainRow({ first: props.first }), flexDirection: "column", alignItems: "stretch", gap: controlSize.padding }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: controlSize.gap }}>
        <RowLabel label={props.label} />
        <Text style={{ fontSize: controlSize.label, color: ui().muted, fontVariant: ["tabular-nums"] }}>{props.value ?? ""}</Text>
      </View>
      {props.children}
    </View>
  );
}

function App() {
  const strength = signal(64);
  const position = signal(84);
  const price = signal<[number, number]>([200, 800]);
  const bands = [signal(0), signal(3), signal(-2)];
  const events = signal<string[]>([]);
  const log = (name: string) => ({ value: next }: { value: SliderValue }) => events.set([`${name} → ${show(next)}`, ...events()].slice(0, 5));
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>slider</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Drag a thumb or click the track, or Tab to a thumb and use the arrow keys" : "Drag a thumb, or tap the track"}
      </Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="value">
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                strength {strength()} · position {position()} · price [{price()[0]}, {price()[1]}]
              </Text>
              <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                bands {bands.map((b) => b()).join(" / ")}
              </Text>
            </Panel>
            <Log title="onChangeEnd({ value })" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={sectionSurface({ padded: true })}>
          <Row first label="Option strength">
            <Slider
              value={strength()}
              onChange={({ value }) => strength.set(value as number)}
              onChangeEnd={log("strength")}
              accessibilityLabel="Option strength"
              rangeStyle={sliderFill(0, strength() / 100)}
              {...sliderLook({ value: true })}
            >
              <Text class={sliderValueClass} style={sliderValueStyle()}>{`${strength()}%`}</Text>
            </Slider>
          </Row>
          <Row label="Playback position" value={`${clock(position())} / ${clock(LENGTH)}`}>
            <Slider
              value={position()}
              max={LENGTH}
              onChange={({ value }) => position.set(value as number)}
              onChangeEnd={log("position")}
              accessibilityLabel="Playback position"
              rangeStyle={sliderFill(0, position() / LENGTH)}
              {...sliderLook()}
            />
          </Row>
          <Row label="Price" value={`$${price()[0]} – $${price()[1]}`}>
            <Slider
              value={price()}
              min={0}
              max={1000}
              step={10}
              onChange={({ value }) => price.set(value as [number, number])}
              onChangeEnd={log("price")}
              startAccessibilityLabel="Minimum price"
              accessibilityLabel="Maximum price"
              rangeStyle={sliderFill(price()[0] / 1000, price()[1] / 1000)}
              {...sliderLook()}
            />
          </Row>
          <Row label="Locked intensity">
            <Slider value={72} disabled accessibilityLabel="Locked intensity" rangeStyle={sliderFill(0, 0.72)} {...sliderLook({ value: true })}>
              <Text class={sliderValueClass} style={sliderValueStyle()}>72%</Text>
            </Slider>
          </Row>
          <Row label="Equalizer" value="dB">
            <View class="flex-row justify-around pt-1">
              {["Bass", "Mid", "Treble"].map((name, i) => (
                <View class="items-center gap-2">
                  <Slider
                    value={bands[i]()}
                    min={-12}
                    max={12}
                    axis="vertical"
                    onChange={({ value }) => bands[i].set(value as number)}
                    onChangeEnd={log(name.toLowerCase())}
                    accessibilityLabel={name}
                    rangeStyle={sliderFill(0, (bands[i]() + 12) / 24, true)}
                    {...sliderLook({ vertical: true })}
                  />
                  <Text style={{ fontSize: controlSize.detail, color: ui().muted, fontVariant: ["tabular-nums"] }}>
                    {`${name} ${bands[i]() > 0 ? "+" : ""}${bands[i]()}`}
                  </Text>
                </View>
              ))}
            </View>
          </Row>
        </View>
      </Split>
    </View>
  );
}

mount(App);
