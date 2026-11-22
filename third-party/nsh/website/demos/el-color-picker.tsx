import { Image, type JSX, mount, signal, Text, View } from "nsh";
import { type ColorFormat, ColorPicker } from "nsh/base";
import { ColorPanel, ColorPopover, desktop, insetSurface, Log, photoUrl, size, Split, ui, sectionSurface } from "./palette";

// `ColorPicker` holds the color; its parts, laid out and styled by the app,
// read and change it. Three pickers in a card, with the shared look
// (`ColorPanel`, `ColorPopover`): a fill picked in place (the area, the
// eyedropper where the browser has one, hue and opacity, the copy button,
// the color typed in the format its menu picks, preset swatches); an accent
// color whose field opens the picker in a popover; and a banner's overlay,
// its opacity included, written as rgb().

// The preset swatches and the overlay's color are the user's content, not the interface's look.
const SWATCHES = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

/** A label over its control, a quieter line under the label. */
function Field(props: { label: string; detail: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: size.label, fontWeight: "500", color: ui().text }}>{props.label}</Text>
        <Text style={{ fontSize: size.detail, color: ui().muted }}>{props.detail}</Text>
      </View>
      {props.children}
    </View>
  );
}

/** A trigger's width: set with a pointer, the field's on a touch screen. */
const trigger = desktop ? { width: 260 } : undefined;

function App() {
  const fill = signal("#6366f1ff");
  const fillFormat = signal<ColorFormat>("hex");
  const accent = signal("#0ea5e9ff");
  const accentFormat = signal<ColorFormat>("hex");
  // rgb(15 23 42 / 0.55): slate at 55%.
  const overlay = signal("#0f172a8c");
  const overlayFormat = signal<ColorFormat>("rgb");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 6));
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>color-picker</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Drag the area or a slider, type a color, or pick a swatch" : "Drag the area or a slider, or tap a swatch"}
      </Text>
      <Split gap={14} inspector={<Log title="onChangeEnd({ formatted })" lines={events()} minHeight={120} />}>
        <View style={{ ...sectionSurface({ padded: true }), gap: 24 }}>
          <Field label="Fill color" detail="In place: opacity, the format's fields and presets">
            <ColorPicker
              value={fill()}
              format={fillFormat()}
              onChange={({ value }) => fill.set(value)}
              onChangeEnd={({ formatted }) => log(`Fill ${formatted}`)}
            >
              <ColorPanel name="Fill color" value={fill()} format={fillFormat()} onFormatChange={(f) => fillFormat.set(f)} alpha swatches={SWATCHES} />
            </ColorPicker>
          </Field>
          <Field label="Accent color" detail="Used for links, focus rings and primary buttons.">
            <ColorPopover
              name="Accent color"
              value={accent()}
              format={accentFormat()}
              style={trigger}
              onChange={(v) => accent.set(v)}
              onFormatChange={(f) => accentFormat.set(f)}
              onChangeEnd={(formatted) => log(`Accent ${formatted}`)}
            />
          </Field>
          <Field label="Banner overlay" detail="Darken the artwork so the headline stays readable.">
            {/* The artwork under the overlay the picker sets: the headline stays readable as it darkens. */}
            <View style={{ ...insetSurface(), height: 140, justifyContent: "flex-end", padding: 16, overflow: "hidden" }}>
              <Image src={photoUrl("sunrise")} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, objectFit: "cover" }} />
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: overlay() }} />
              <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 0.6, color: "white", opacity: 0.8 }}>NEW SEASON</Text>
              <Text style={{ fontSize: 18, fontWeight: "600", color: "white" }}>Spring collection</Text>
            </View>
            <ColorPopover
              name="Banner overlay"
              value={overlay()}
              format={overlayFormat()}
              alpha
              style={trigger}
              onChange={(v) => overlay.set(v)}
              onFormatChange={(f) => overlayFormat.set(f)}
              onChangeEnd={(formatted) => log(`Overlay ${formatted}`)}
            />
          </Field>
        </View>
      </Split>
    </View>
  );
}

mount(App);
