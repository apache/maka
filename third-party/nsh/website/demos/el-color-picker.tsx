import { mount, signal, Text, View } from "nsh";
import { type ColorChannel, ColorArea, ColorEyeDropper, ColorField, ColorPicker, ColorSlider, type ColorSpace, ColorSwatch } from "nsh/base";
import { desktop, field, Icon, Log, Segmented, Split, ui } from "./palette";

// `ColorPicker` holds the color; its parts, laid out and styled here, read
// and change it: the saturation and brightness area, the hue and alpha
// sliders, a row per channel of the space picked (its slider and its
// number), the color typed in any CSS form, the browser's eyedropper where
// it has one, and a palette of swatches.
const thumb = "rounded-full border-2 border-white";
const thumbStyle = { boxShadow: "0 0 0 1px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.3)" };
const spaces = ["rgb", "hsl", "hsb", "oklch"] as const;
const channels: Record<ColorSpace, [ColorChannel, string][]> = {
  rgb: [["red", "R"], ["green", "G"], ["blue", "B"]],
  hsl: [["hue", "H"], ["saturation", "S"], ["lightness", "L"]],
  hsb: [["hue", "H"], ["saturation", "S"], ["brightness", "B"]],
  oklch: [["lightness", "L"], ["chroma", "C"], ["hue", "H"]],
};
const palette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#0f172a80"];

/** A track `h` points high, half a thumb free at each end for the thumb. */
const track = (h: number) => ({
  class: `h-[${h + 8}px] justify-center px-[${(h + 6) / 2}px]`,
  trackClass: `h-[${h}px] rounded-full`,
  thumbClass: `w-[${h + 6}px] h-[${h + 6}px] ${thumb}`,
  thumbStyle,
  fillThumb: true,
});

function App() {
  const color = signal("#3b82f6ff");
  const text = signal("#3b82f6");
  const space = signal<ColorSpace>("oklch");
  const events = signal<string[]>([]);
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>color picker</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Drag the area or a slider, type a color, or pick a swatch" : "Drag the area or a slider, or tap a swatch"}
      </Text>
      <Split
        gap={14}
        inspector={
<Log title="onChangeEnd({ value, formatted })" lines={events()} minHeight={92} />
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: 16 }}>
          <ColorPicker
            value={color()}
            onChange={({ value, formatted }) => {
              color.set(value);
              text.set(formatted);
            }}
            onChangeEnd={({ formatted }) => events.set([formatted, ...events()].slice(0, 5))}
            style={{ gap: 12 }}
          >
            <ColorArea
              accessibilityLabel="Saturation and brightness"
              style={{ height: desktop ? 160 : 140 }}
              panelClass="rounded-lg"
              thumbClass={`w-[18px] h-[18px] ${thumb}`}
              thumbStyle={thumbStyle}
              fillThumb
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <ColorSwatch accessibilityLabel="Current color" style={{ width: 36, height: 36, borderRadius: 18 }} checkerboardColor="#d4d4d8" />
              <View style={{ flex: 1, gap: 8 }}>
                <ColorSlider colorSpace="hsb" channel="hue" accessibilityLabel="Hue" {...track(12)} />
                <ColorSlider channel="alpha" accessibilityLabel="Alpha" checkerboardColor="#d4d4d8" {...track(12)} />
              </View>
            </View>
            <Text style={{ fontSize: 13, color: ui().muted, fontVariant: ["tabular-nums"] }}>{text()}</Text>
            <Segmented options={spaces} value={space()} onChange={(next) => space.set(next)} />
            {() =>
              channels[space()].map(([channel, letter]) => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Text style={{ width: 14, fontSize: 13, color: ui().muted }}>{letter}</Text>
                  <ColorSlider colorSpace={space()} channel={channel} accessibilityLabel={`${space()} ${channel}`} style={{ flex: 1 }} {...track(10)} />
                  <ColorField
                    colorSpace={space()}
                    channel={channel}
                    accessibilityLabel={`${space()} ${channel} value`}
                    {...field({ style: { width: 64, textAlign: "right" } })}
                  />
                </View>
              ))
            }
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ColorField
                accessibilityLabel="Color"
                placeholder="#rrggbb, rgb(), hsl(), oklch() or a name"
                {...field({ style: { flex: 1 } })}
              />
              <ColorEyeDropper
                accessibilityLabel="Pick a color from the screen"
                class="disabled:hidden w-9 h-9 items-center justify-center rounded-md border border-border active:opacity-70"
              >
                <Icon name="pipette" size={16} tint={ui().text} />
              </ColorEyeDropper>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {palette.map((c) => (
                <ColorSwatch
                  color={c}
                  style={{ width: 24, height: 24, borderRadius: 6 }}
                  selectedStyle={{ borderWidth: 2, borderColor: ui().text }}
                  checkerboardColor="#d4d4d8"
                  checkerboardSize={6}
                />
              ))}
            </View>
          </ColorPicker>
        </View>
      </Split>
    </View>
  );
}

mount(App);
