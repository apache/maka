import { signal, Text, View } from "nsh";
import { type ColorChannel, ColorArea, ColorEyeDropper, ColorField, ColorPicker, ColorSlider, type ColorSpace, ColorSwatch } from "nsh/base";
import { platform } from "nsh";
import { Card, colors, DemoPage, focusRing, Icon, mono, Segmented } from "../ui";

// `nsh/base`'s `ColorPicker` holds the color and its parts read and change
// it; the layout and every look are the app's. A color picked on the
// saturation and brightness area, the hue and alpha sliders under it, then
// the channels of the space the user picks, each a slider and its number;
// the whole color typed in any CSS form; a palette of swatches. The second
// card adjusts a theme token in OKLCH, a row per channel.

const pointer = platform.desktop;
const thumb = "rounded-full border-2 border-white";
const thumbStyle = { boxShadow: "0 0 0 1px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.3)" };

/** The channels of each space, as the sliders' labels name them. */
const spaces: Record<ColorSpace, { channel: ColorChannel; label: string }[]> = {
  rgb: [
    { channel: "red", label: "R" },
    { channel: "green", label: "G" },
    { channel: "blue", label: "B" },
  ],
  hsl: [
    { channel: "hue", label: "H" },
    { channel: "saturation", label: "S" },
    { channel: "lightness", label: "L" },
  ],
  hsb: [
    { channel: "hue", label: "H" },
    { channel: "saturation", label: "S" },
    { channel: "brightness", label: "B" },
  ],
  oklch: [
    { channel: "lightness", label: "L" },
    { channel: "chroma", label: "C" },
    { channel: "hue", label: "H" },
  ],
};

const palette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#0f172a80"];

/** A track and its thumb, `h` points high; half a thumb free at each end
 * keeps the thumb inside the slider, where it takes presses. */
const track = (h: number) => ({
  class: `h-[${h + 8}px] justify-center px-[${(h + 6) / 2}px]`,
  trackClass: `h-[${h}px] rounded-full`,
  thumbClass: `w-[${h + 6}px] h-[${h + 6}px] ${thumb}`,
  thumbStyle,
  fillThumb: true,
});

/** A channel's row: its letter, its slider, its number. */
function Channel(props: { space: ColorSpace; channel: ColorChannel; label: string; name: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text style={{ width: 14, fontSize: 13, color: colors.muted, fontFamily: mono }}>{props.label}</Text>
      <ColorSlider
        colorSpace={props.space}
        channel={props.channel}
        accessibilityLabel={props.name}
        style={{ flex: 1 }}
        {...track(10)}
      />
      <ColorField
        colorSpace={props.space}
        channel={props.channel}
        accessibilityLabel={`${props.name} value`}
        style={{
          width: 64,
          height: 28,
          paddingHorizontal: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.field,
        }}
        class="text-[13px] font-mono text-right text-foreground"
        focusStyle={focusRing()}
      />
    </View>
  );
}

const names: Record<ColorChannel, string> = {
  red: "Red",
  green: "Green",
  blue: "Blue",
  hue: "Hue",
  saturation: "Saturation",
  lightness: "Lightness",
  brightness: "Brightness",
  chroma: "Chroma",
  alpha: "Alpha",
};

export function ColorPickerDemo() {
  const color = signal("#3b82f6ff");
  const text = signal("#3b82f6");
  const space = signal<ColorSpace>("hsb");
  const primary = signal("oklch(54.6% 0.215 262.9)");
  const last = signal("—");

  function Picker() {
    return (
      <Card icon="styles" title="ColorPicker" subtitle="An area, sliders of any space, a field and swatches">
        <ColorPicker
          value={color()}
          onChange={({ value, formatted }) => {
            color.set(value);
            text.set(formatted);
          }}
          onChangeEnd={({ formatted }) => last.set(`Picked ${formatted}`)}
          style={{ gap: 12 }}
        >
          <ColorArea
            accessibilityLabel="Saturation and brightness"
            style={{ height: pointer ? 160 : 200 }}
            panelClass="rounded-lg"
            thumbClass={`w-[18px] h-[18px] ${thumb}`}
            thumbStyle={thumbStyle}
            fillThumb
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <ColorSwatch
              accessibilityLabel="Current color"
              style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border }}
              checkerboardColor="#d4d4d8"
            />
            <View style={{ flex: 1, gap: 8 }}>
              <ColorSlider colorSpace="hsb" channel="hue" accessibilityLabel="Hue" {...track(12)} />
              <ColorSlider testID="alpha" channel="alpha" accessibilityLabel="Alpha" checkerboardColor="#d4d4d8" {...track(12)} />
            </View>
          </View>
          <Segmented
            options={[
              { value: "rgb", label: "RGB" },
              { value: "hsl", label: "HSL" },
              { value: "hsb", label: "HSB" },
              { value: "oklch", label: "OKLCH" },
            ]}
            value={space()}
            onChange={(next) => space.set(next)}
            fill
          />
          {() =>
            spaces[space()].map((c) => (
              <Channel space={space()} channel={c.channel} label={c.label} name={`${space().toUpperCase()} ${names[c.channel]}`} />
            ))
          }
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ColorField
              accessibilityLabel="Color"
              placeholder="#rrggbb, rgb(), hsl(), oklch() or a name"
              style={{
                flex: 1,
                height: 32,
                paddingHorizontal: 10,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.field,
              }}
              class="text-[13px] font-mono text-foreground"
              focusStyle={focusRing()}
            />
            {/* The system's eyedropper (macOS, browsers with one); hidden where there is none. */}
            <ColorEyeDropper
              accessibilityLabel="Pick a color from the screen"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.field,
                alignItems: "center",
                justifyContent: "center",
              }}
              class="disabled:hidden active:opacity-70"
            >
              <Icon name="pipette" size={16} tint={colors.text} />
            </ColorEyeDropper>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {palette.map((c) => (
              <ColorSwatch
                color={c}
                style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.border }}
                selectedStyle={{ borderWidth: 2, borderColor: colors.text }}
                checkerboardColor="#d4d4d8"
                checkerboardSize={6}
              />
            ))}
          </View>
        </ColorPicker>
        <Text style={{ fontSize: 13, color: colors.muted, fontFamily: mono }}>{text()}</Text>
      </Card>
    );
  }

  function Token() {
    return (
      <Card icon="styles" title="Primary color" subtitle="A theme token adjusted in OKLCH">
        <ColorPicker
          value={primary()}
          format="oklch"
          onChange={({ formatted }) => primary.set(formatted)}
          onChangeEnd={({ formatted }) => last.set(`--primary: ${formatted}`)}
          style={{ gap: 10 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ColorSwatch accessibilityLabel="Primary" style={{ width: 28, height: 28, borderRadius: 6 }} />
            <Text style={{ flex: 1, fontSize: 13, color: colors.text, fontFamily: mono }}>{`--primary: ${primary()}`}</Text>
          </View>
          {spaces.oklch.map((c) => (
            <Channel space="oklch" channel={c.channel} label={c.label} name={`Primary ${names[c.channel]}`} />
          ))}
        </ColorPicker>
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Picker, Token, Last]} />;
}
