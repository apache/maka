import { Canvas, mount, signal, Text, View } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, Split, tint, ui } from "./palette";

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

/** Three lines of a paragraph, set as `align` sets them. */
function Lines(props: { align: Align; color: string }) {
  return (
    <Canvas
      style={{ pointerEvents: "none", width: 16, height: 16 }}
      draw={(cx) => {
        cx.strokeStyle = props.color;
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
  // A toolbar toggle: bare while off, raised while pressed (`pressedStyle`).
  const look = (pressed: boolean) => ({
    style: { width: desktop ? 28 : 34, height: desktop ? 28 : 34, borderRadius: 7, alignItems: "center", justifyContent: "center" } as const,
    class: "transition-colors active:opacity-70 motion-reduce:transition-none",
    pressedStyle: ui().raised,
    hoverStyle: pressed ? undefined : hoverFill(),
    focusStyle: focusRing(),
  });
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>toggle</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click a toggle, or Tab to the toolbar and move with the arrow keys" : "Tap a toggle to turn it on or off"}
      </Text>

      <Split gap={14} inspector={<Log title={`onChange · ${on().join(", ") || "none"}, ${align()}`} lines={events()} minHeight={76} />}>
        {/* One toolbar: the marks any number at once, the alignment exactly one. */}
        <ToggleGroup style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 2, padding: 3, borderRadius: 10, ...ui().inset }}>
          <Each of={marks}>
            {(m) => (
              <Toggle
                pressed={has(m().id)}
                accessibilityLabel={m().label}
                onChange={({ pressed }) => {
                  on.set(pressed ? [...on(), m().id] : on().filter((x) => x !== m().id));
                  log(`${m().label}: ${pressed}`);
                }}
                {...look(has(m().id))}
              >
                <Text
                  style={{
                    fontSize: 14,
                    color: has(m().id) ? ui().text : ui().muted,
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
          <View style={{ width: 1, height: 16, marginHorizontal: 4, backgroundColor: ui().line }} />
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
                {...look(align() === a().id)}
              >
                <Lines align={a().id} color={align() === a().id ? ui().text : ui().muted} />
              </Toggle>
            )}
          </Each>
        </ToggleGroup>

        {/* The text the toolbar formats: the app reads its own values. */}
        <View style={{ ...ui().card, borderRadius: 14, padding: 14 }}>
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

        {/* A toggle on its own, with a label: `aria-pressed:` tints it. */}
        <Toggle
          pressed={starred()}
          onChange={({ pressed }) => {
            starred.set(pressed);
            log(`Star: ${pressed}`);
          }}
          class="transition-colors active:opacity-70 motion-reduce:transition-none"
          style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, height: desktop ? 28 : 34, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: ui().line }}
          pressedStyle={{ backgroundColor: tint(ui().accent, 0.16), borderColor: tint(ui().accent, 0.4) }}
          hoverStyle={starred() ? undefined : hoverFill()}
          focusStyle={focusRing()}
        >
          <Text style={{ fontSize: 14, color: starred() ? ui().accent : ui().muted }}>{starred() ? "★" : "☆"}</Text>
          <Text style={{ fontSize: 13, fontWeight: "500", color: starred() ? ui().accent : ui().text }}>{starred() ? "Starred" : "Star"}</Text>
        </Toggle>
      </Split>
    </View>
  );
}

mount(App);
