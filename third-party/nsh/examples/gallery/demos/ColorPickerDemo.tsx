import { Image, type InputStyle, type JSX, signal, Text, View } from "nsh";
import { type ColorChannel, ColorField, type ColorFormat, ColorPicker, ColorSlider, ColorSwatch } from "nsh/base";
import { Card, colorChecker, ColorPanel, ColorPopover, colorSliderLook, colors, DemoPage, density, Inset, inputLook, LastEvent, mono, photoUrl, TERMINAL_COLUMN, TERMINAL_ROW, terminal } from "../ui";

// `nsh/base`'s `ColorPicker` holds the color and its parts read and change
// it; the layout and every look are the app's, here the gallery's shared
// ones (`look/color.tsx`), arranged as ReUI's color picker: a picker in
// place with the opacity and preset swatches; a labelled field whose
// outline trigger opens the picker in a popover; a banner's overlay, its
// opacity included, written as rgb(); and a theme token adjusted in OKLCH,
// a row per channel.

const SWATCHES = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

/** A field's label over it and its description under it, as the form's fields have them. */
function Labelled(props: { label: string; description: string; children: JSX.Element }) {
  return (
    <View style={{ gap: terminal ? 0 : 6 }}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text }}>{props.label}</Text>
      {props.children}
      <Text style={{ fontSize: density.note, color: colors.muted }}>{props.description}</Text>
    </View>
  );
}

/** A channel's letter: two Cells in a terminal, then a Cell before the slider. */
const LABEL = terminal ? 2 * TERMINAL_COLUMN : 14;

/** `inputLook`'s class and style for a `ColorField` (its edge's states are classes), read where they are drawn so they follow the theme. */
function fieldOf(style: InputStyle) {
  const look = inputLook({ style });
  return {
    get class() {
      return look.class;
    },
    get style() {
      return look.style;
    },
  };
}

/** A number's field: the form's text field, 64 wide, the number right-aligned in tabular figures; a terminal's is the number alone in six Cells. */
const channelField = () =>
  terminal
    ? { style: { width: 6 * TERMINAL_COLUMN, height: TERMINAL_ROW }, class: "text-[13px] text-right text-foreground" }
    : fieldOf({ width: 64, paddingHorizontal: 8, textAlign: "right", fontVariant: ["tabular-nums"] });

/** A channel's row: its letter, its slider, its number. */
function Channel(props: { channel: ColorChannel; label: string; name: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: terminal ? TERMINAL_COLUMN : 10 }}>
      <Text style={{ width: LABEL, fontSize: 13, color: colors.muted }}>{props.label}</Text>
      <ColorSlider colorSpace="oklch" channel={props.channel} accessibilityLabel={props.name} {...colorSliderLook({ style: { flex: 1 } })} />
      <ColorField colorSpace="oklch" channel={props.channel} accessibilityLabel={`${props.name} value`} {...channelField()} />
    </View>
  );
}

export function ColorPickerDemo() {
  const last = signal("—");

  function Fill() {
    const color = signal("#6366f1ff");
    const format = signal<ColorFormat>("hex");
    return (
      <Card icon="styles" title="Fill color" subtitle="In place: opacity, the format's fields and presets">
        <ColorPicker
          value={color()}
          format={format()}
          onChange={({ value }) => color.set(value)}
          onChangeEnd={({ formatted }) => last.set(`Picked ${formatted}`)}
        >
          <ColorPanel name="Fill color" value={color()} format={format()} onFormatChange={(f) => format.set(f)} alpha swatches={SWATCHES} />
        </ColorPicker>
      </Card>
    );
  }

  function Accent() {
    const color = signal("#0ea5e9ff");
    const format = signal<ColorFormat>("hex");
    return (
      <Card icon="styles" title="Accent color" subtitle="A field whose trigger opens the picker">
        <Labelled label="Accent color" description="Used for links, focus rings and primary buttons.">
          <ColorPopover
            name="Accent color"
            value={color()}
            format={format()}
            onChange={(v) => color.set(v)}
            onFormatChange={(f) => format.set(f)}
            onChangeEnd={(formatted) => last.set(`Accent ${formatted}`)}
          />
        </Labelled>
      </Card>
    );
  }

  function Banner() {
    // rgb(15 23 42 / 0.55): slate at 55%.
    const overlay = signal("#0f172a8c");
    const format = signal<ColorFormat>("rgb");
    return (
      <Card icon="styles" title="Banner overlay" subtitle="Its opacity too, written as rgb()" flush>
        {/* The artwork under the overlay the picker sets: the headline stays readable as it darkens. */}
        <View style={{ height: terminal ? 6 * TERMINAL_ROW : 160, justifyContent: "flex-end", padding: terminal ? 0 : 20, backgroundColor: colors.raised }}>
          <Image src={photoUrl("sunrise")} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, objectFit: "cover" }} />
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: overlay() }} />
          <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 0.6, color: "white", opacity: 0.8 }}>NEW SEASON</Text>
          <Text style={{ fontSize: 18, fontWeight: "600", color: "white" }}>Spring collection</Text>
        </View>
        <Inset>
          <Labelled label="Banner overlay" description="Darken the artwork so the headline stays readable.">
            <ColorPopover
              name="Banner overlay"
              value={overlay()}
              format={format()}
              alpha
              onChange={(v) => overlay.set(v)}
              onFormatChange={(f) => format.set(f)}
              onChangeEnd={(formatted) => last.set(`Overlay ${formatted}`)}
            />
          </Labelled>
        </Inset>
      </Card>
    );
  }

  function Token() {
    const primary = signal("oklch(54.6% 0.215 262.9)");
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
            <ColorSwatch
              accessibilityLabel="Primary"
              class={terminal ? undefined : "border border-foreground/10"}
              style={terminal ? { width: LABEL, height: TERMINAL_ROW } : { width: 28, height: 28, borderRadius: 6 }}
              {...colorChecker()}
            />
            <Text style={{ flex: 1, fontSize: 13, color: colors.text, fontFamily: mono }}>{`--primary: ${primary()}`}</Text>
          </View>
          <Channel channel="lightness" label="L" name="Primary Lightness" />
          <Channel channel="chroma" label="C" name="Primary Chroma" />
          <Channel channel="hue" label="H" name="Primary Hue" />
        </ColorPicker>
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <LastEvent value={last()} hint="Pick a color" />
      </Card>
    );
  }

  return <DemoPage cards={[Fill, Accent, Banner, Token, Last]} />;
}
