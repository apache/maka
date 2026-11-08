import { type JSX, signal, Text, View } from "nsh";
import { type ColorChannel, ColorArea, ColorEyeDropper, ColorField, ColorPicker, ColorSlider, type ColorSpace, ColorSwatch } from "nsh/base";
import { platform } from "nsh";
import { Card, colors, DemoPage, focusRing, Icon, mono, Segmented, TERMINAL_COLUMN, TERMINAL_ROW, terminal } from "../ui";

// `nsh/base`'s `ColorPicker` holds the color and its parts read and change
// it; the layout and every look are the app's. A color picked on the
// saturation and brightness area, the hue and alpha sliders under it, then
// the channels of the space the user picks, each a slider and its number;
// the whole color typed in any CSS form; a palette of swatches. The second
// card adjusts a theme token in OKLCH, a row per channel. In a terminal
// every slider is one row of its colors (the picker's terminal form, so no
// track or thumb looks), the numbers a column at the end of their rows, the
// whole color on a row of its own under the sliders, swatches two Cells
// wide.

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

/** A channel's letter: two Cells in a terminal, then a Cell before the slider. */
const LABEL = terminal ? 2 * TERMINAL_COLUMN : 14;

/** In a terminal, what starts where the sliders do: after a blank as wide as
 * a channel's letter and the Cell after it (a terminal's margins come in
 * steps of Cells, so the blank is a box, as the letter is). */
function UnderSliders(props: { children: JSX.Element }) {
  return terminal ? (
    <View style={{ flexDirection: "row", gap: TERMINAL_COLUMN }}>
      <View style={{ width: LABEL, height: TERMINAL_ROW }} />
      <View style={{ flex: 1 }}>{props.children}</View>
    </View>
  ) : (
    props.children
  );
}

/** A track and its thumb, `h` points high; half a thumb free at each end
 * keeps the thumb inside the slider, where it takes presses. A terminal's
 * slider is one row of its colors: no looks of the parts. */
const track = (h: number) => (terminal ? {} : {
  class: `h-[${h + 8}px] justify-center px-[${(h + 6) / 2}px]`,
  trackClass: `h-[${h}px] rounded-full`,
  thumbClass: `w-[${h + 6}px] h-[${h + 6}px] ${thumb}`,
  thumbStyle,
  fillThumb: true,
});

/** A number's field: a terminal's is the number alone, right-aligned in six
 * Cells on its slider's row (five for `262.9`, one for the caret). */
const fieldStyle = terminal
  ? { width: 6 * TERMINAL_COLUMN, height: TERMINAL_ROW }
  : {
      width: 64,
      height: 28,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.field,
    };

/** A channel's row: its letter, its slider, its number. */
function Channel(props: { space: ColorSpace; channel: ColorChannel; label: string; name: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: terminal ? TERMINAL_COLUMN : 10 }}>
      <Text style={{ width: LABEL, fontSize: 13, color: colors.muted, fontFamily: mono }}>{props.label}</Text>
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
        style={fieldStyle}
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
          style={{ gap: terminal ? TERMINAL_ROW : 12 }}
        >
          {terminal ? (
            // Eight rows of Cells across the card.
            <ColorArea accessibilityLabel="Saturation and brightness" style={{ height: 8 * TERMINAL_ROW }} />
          ) : (
            <ColorArea
              accessibilityLabel="Saturation and brightness"
              style={{ height: pointer ? 160 : 200 }}
              panelClass="rounded-lg"
              thumbClass={`w-[18px] h-[18px] ${thumb}`}
              thumbStyle={thumbStyle}
              fillThumb
            />
          )}
          {/* In a terminal the swatch stretches to the two sliders' rows beside it. */}
          <View style={{ flexDirection: "row", alignItems: terminal ? "stretch" : "center", gap: terminal ? TERMINAL_COLUMN : 12 }}>
            <ColorSwatch
              accessibilityLabel="Current color"
              style={
                terminal
                  ? { width: LABEL }
                  : { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border }
              }
              checkerboardColor="#d4d4d8"
            />
            <View style={{ flex: 1, gap: terminal ? 0 : 8 }}>
              <ColorSlider colorSpace="hsb" channel="hue" accessibilityLabel="Hue" {...track(12)} />
              <ColorSlider testID="alpha" channel="alpha" accessibilityLabel="Alpha" checkerboardColor="#d4d4d8" {...track(12)} />
            </View>
          </View>
          {/* A terminal's tabs as wide as their words, over the sliders' column. */}
          <UnderSliders>
            <View style={{ alignItems: terminal ? "flex-start" : "stretch" }}>
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
            </View>
          </UnderSliders>
          {() =>
            spaces[space()].map((c) => (
              <Channel space={space()} channel={c.channel} label={c.label} name={`${space().toUpperCase()} ${names[c.channel]}`} />
            ))
          }
          <UnderSliders>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ColorField
                accessibilityLabel="Color"
                placeholder="#rrggbb, rgb(), hsl(), oklch() or a name"
                style={
                  terminal
                    ? { flex: 1, height: TERMINAL_ROW }
                    : {
                        flex: 1,
                        height: 32,
                        paddingHorizontal: 10,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.field,
                      }
                }
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
          </UnderSliders>
          <UnderSliders>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {palette.map((c) => (
                <ColorSwatch
                  color={c}
                  // Two Cells by one row in a terminal, a Cell apart.
                  style={terminal ? { width: 2 * TERMINAL_COLUMN, height: TERMINAL_ROW } : { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.border }}
                  selectedStyle={terminal ? undefined : { borderWidth: 2, borderColor: colors.text }}
                  checkerboardColor="#d4d4d8"
                  checkerboardSize={6}
                />
              ))}
            </View>
          </UnderSliders>
        </ColorPicker>
        <UnderSliders>
          <Text style={{ fontSize: 13, color: colors.muted, fontFamily: mono }}>{text()}</Text>
        </UnderSliders>
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
          style={{ gap: terminal ? 0 : 10 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: terminal ? TERMINAL_COLUMN : 10, marginBottom: terminal ? TERMINAL_ROW : 0 }}>
            <ColorSwatch accessibilityLabel="Primary" style={terminal ? { width: LABEL, height: TERMINAL_ROW } : { width: 28, height: 28, borderRadius: 6 }} />
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
