import { Canvas, mount, signal, Text, View } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";
import { desktop, Log, Split, tint, toggleGlyph, toggleLabel, toggleLook, toolbarRule, toolbarTrack, ui, sectionSurface } from "./palette";

type Mark = "bold" | "italic" | "underline";
type Align = "left" | "center" | "right";

const marks: { id: Mark; label: string; glyph: string }[] = [
  { id: "bold", label: "Bold", glyph: "B" },
  { id: "italic", label: "Italic", glyph: "I" },
  { id: "underline", label: "Underline", glyph: "U" },
];
const aligns: { id: Align; label: string }[] = [
  { id: "left", label: "Align left" },
  { id: "center", label: "Align center" },
  { id: "right", label: "Align right" },
];

/** Three lines of a paragraph, set as `align` sets them, drawn on a 16-point grid. */
function Lines(props: { align: Align; tint: string; size: number }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: props.size, height: props.size }}
      draw={(cx) => {
        cx.scale(props.size / 16, props.size / 16);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 1.6;
        cx.lineCap = "round";
        [12, 7, 10].forEach((w, i) => {
          const x = props.align === "center" ? 8 - w / 2 : props.align === "right" ? 14 - w : 2;
          cx.beginPath();
          cx.moveTo(x, 4 + i * 4);
          cx.lineTo(x + w, 4 + i * 4);
          cx.stroke();
        });
      }}
    />
  );
}

function App() {
  const on = signal<Mark[]>(["bold"]);
  const align = signal<Align>("left");
  const starred = signal(false);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  const has = (m: Mark) => on().includes(m);
  // A toolbar toggle in the toggles' look (`toggleLook`): bare while off,
  // the on fill while pressed, its label or icon muted until it is on.
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>toggle</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click a toggle, or Tab to the toolbar and move with the arrow keys" : "Tap a toggle to turn it on or off"}
      </Text>

      <Split gap={14} inspector={<Log title={`onChange · ${on().join(", ") || "none"}, ${align()}`} lines={events()} minHeight={76} />}>
        {/* One toolbar: the marks any number at once, the alignment exactly one. */}
        <ToggleGroup style={{ ...toolbarTrack(), alignSelf: "flex-start" }}>
          <Each of={marks}>
            {(m) => (
              <Toggle
                pressed={has(m().id)}
                accessibilityLabel={m().label}
                onChange={({ pressed }) => {
                  on.set(pressed ? [...on(), m().id] : on().filter((x) => x !== m().id));
                  log(`${m().label}: ${pressed}`);
                }}
                {...toggleLook()}
              >
                <Text
                  style={{
                    ...toggleLabel(() => has(m().id)),
                    fontWeight: m().id === "bold" ? "800" : "500",
                    fontStyle: m().id === "italic" ? "italic" : "normal",
                    textDecorationLine: m().id === "underline" ? "underline" : "none",
                  }}
                >
                  {m().glyph}
                </Text>
              </Toggle>
            )}
          </Each>
          <View style={toolbarRule()} />
          <Each of={aligns}>
            {(a) => (
              <Toggle
                pressed={align() === a().id}
                accessibilityLabel={a().label}
                onChange={({ pressed }) => {
                  // Exactly one: the pressed alignment stays pressed.
                  if (pressed) align.set(a().id);
                  log(`${a().label}: ${pressed}`);
                }}
                {...toggleLook()}
              >
                <Lines align={a().id} {...toggleGlyph(() => align() === a().id)} />
              </Toggle>
            )}
          </Each>
        </ToggleGroup>

        {/* The text the toolbar formats: the app reads its own values. */}
        <View style={{ ...sectionSurface({ padded: true }) }}>
          <Text
            style={{
              fontSize: 15,
              lineHeight: 22,
              color: ui().text,
              fontWeight: has("bold") ? "700" : "400",
              fontStyle: has("italic") ? "italic" : "normal",
              textDecorationLine: has("underline") ? "underline" : "none",
              textAlign: align(),
            }}
          >
            Every toggle reports the value it asks for; the app passes it back.
          </Text>
        </View>

        {/* A toggle on its own, with a label: the toggles' look, a favorite's
            accent tint in place of the on fill (`pressedStyle`). */}
        <Toggle
          pressed={starred()}
          onChange={({ pressed }) => {
            starred.set(pressed);
            log(`Star: ${pressed}`);
          }}
          {...toggleLook({ text: true, style: { alignSelf: "flex-start" } })}
          pressedStyle={{ backgroundColor: tint(ui().accent, 0.12), borderColor: tint(ui().accent, 0.3) }}
        >
          <Text style={{ ...toggleLabel(starred), color: starred() ? ui().accent : ui().muted }}>{starred() ? "★" : "☆"}</Text>
          <Text style={toggleLabel(starred, { text: true })}>{starred() ? "Starred" : "Star"}</Text>
        </Toggle>
      </Split>
    </View>
  );
}

mount(App);
