import { mount, signal, Text, View } from "nsh";
import { Button, Toggle, ToggleGroup, Toolbar, ToolbarGroup, ToolbarSeparator } from "nsh/base";
import { desktop, focusRing, hoverFill, Log, Split, ui } from "./palette";

type Mark = "bold" | "italic" | "underline";
type Align = "left" | "center" | "right";
type Tool = "select" | "pen" | "shape" | "text";

const marks: { id: Mark; label: string; glyph: string }[] = [
  { id: "bold", label: "Bold", glyph: "B" },
  { id: "italic", label: "Italic", glyph: "I" },
  { id: "underline", label: "Underline", glyph: "U" },
];
const aligns: { id: Align; label: string; glyph: string }[] = [
  { id: "left", label: "Align left", glyph: "⇤" },
  { id: "center", label: "Align center", glyph: "↔" },
  { id: "right", label: "Align right", glyph: "⇥" },
];
const tools: { id: Tool; label: string; glyph: string }[] = [
  { id: "select", label: "Select", glyph: "↖" },
  { id: "pen", label: "Pen", glyph: "✎" },
  { id: "shape", label: "Rectangle", glyph: "▢" },
  { id: "text", label: "Text", glyph: "T" },
];

const side = desktop ? 28 : 34;

function App() {
  const on = signal<Mark[]>(["bold"]);
  const align = signal<Align>("left");
  const tool = signal<Tool>("select");
  const history = signal<string[]>([]);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  const edit = (what: string) => {
    history.set([...history(), what]);
    log(what);
  };
  const has = (m: Mark) => on().includes(m);
  // A tool: bare while off, raised while pressed, a hover fill, the focus ring.
  const look = (pressed: boolean) => ({
    style: { minWidth: side, height: side, paddingHorizontal: 6, borderRadius: 7, alignItems: "center", justifyContent: "center" } as const,
    class: "transition-colors active:opacity-70 disabled:opacity-35 motion-reduce:transition-none",
    pressedStyle: ui().raised,
    hoverStyle: pressed ? undefined : hoverFill(),
    focusStyle: focusRing(),
  });
  const glyph = (text: string, active: boolean) => <Text style={{ fontSize: 14, fontWeight: "600", color: active ? ui().text : ui().muted }}>{text}</Text>;
  const rule = (vertical = false) => (
    <ToolbarSeparator style={vertical ? { height: 1, alignSelf: "stretch", marginVertical: 4, backgroundColor: ui().line } : { width: 1, height: 16, marginHorizontal: 4, backgroundColor: ui().line }} />
  );
  const bar = { alignItems: "center", gap: 2, padding: 3, borderRadius: 10, ...ui().inset } as const;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>toolbar</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Tab into a toolbar, then move with the arrow keys; Home and End jump to its ends" : "Tap the tools; a screen reader hears each bar as a toolbar"}
      </Text>

      <Split gap={14} inspector={<Log title={`${history().length} edits · ${on().join(", ") || "no marks"}, ${align()} · ${tool()}`} lines={events()} minHeight={76} />}>
        {/* A formatting bar: history, a toggle group of marks (a group of the toolbar), the alignment. */}
        <Toolbar accessibilityLabel="Formatting" style={{ ...bar, alignSelf: "flex-start" }}>
          <ToolbarGroup accessibilityLabel="History">
            <Button accessibilityLabel="Undo" disabled={history().length === 0} onPress={() => {
              history.set(history().slice(0, -1));
              log("Undo");
            }} {...look(false)}>
              {glyph("↶", true)}
            </Button>
          </ToolbarGroup>
          {rule()}
          <ToggleGroup style={{ flexDirection: "row", gap: 2 }}>
            <Each of={marks}>
              {(m) => (
                <Toggle
                  pressed={has(m().id)}
                  accessibilityLabel={m().label}
                  onChange={({ pressed }) => {
                    on.set(pressed ? [...on(), m().id] : on().filter((x) => x !== m().id));
                    edit(`${m().label}: ${pressed}`);
                  }}
                  {...look(has(m().id))}
                >
                  {glyph(m().glyph, has(m().id))}
                </Toggle>
              )}
            </Each>
          </ToggleGroup>
          {rule()}
          <ToolbarGroup accessibilityLabel="Alignment" style={{ gap: 2 }}>
            <Each of={aligns}>
              {(a) => (
                <Toggle
                  pressed={align() === a().id}
                  accessibilityLabel={a().label}
                  onChange={({ pressed }) => {
                    // Exactly one: the pressed alignment stays pressed.
                    if (pressed) align.set(a().id);
                    edit(`${a().label}`);
                  }}
                  {...look(align() === a().id)}
                >
                  {glyph(a().glyph, align() === a().id)}
                </Toggle>
              )}
            </Each>
          </ToolbarGroup>
        </Toolbar>

        <View style={{ flexDirection: "row", gap: 14, alignItems: "stretch" }}>
          {/* A vertical palette: Up and Down move along it. */}
          <Toolbar axis="vertical" accessibilityLabel="Tools" style={{ ...bar, alignSelf: "flex-start" }}>
            <Each of={tools}>
              {(t) => (
                <Toggle
                  pressed={tool() === t().id}
                  accessibilityLabel={t().label}
                  onChange={({ pressed }) => {
                    if (!pressed) return;
                    tool.set(t().id);
                    log(`Tool: ${t().label}`);
                  }}
                  {...look(tool() === t().id)}
                >
                  {glyph(t().glyph, tool() === t().id)}
                </Toggle>
              )}
            </Each>
            {rule(true)}
            <Button accessibilityLabel="Clear canvas" onPress={() => log("Clear canvas")} {...look(false)}>
              {glyph("⌫", false)}
            </Button>
          </Toolbar>
          <View style={{ flex: 1, ...ui().card, borderRadius: 14, padding: 14, gap: 6 }}>
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
              One stop of Tab per toolbar; its arrows move between the tools.
            </Text>
            <Text style={{ fontSize: 13, color: ui().muted }}>{`Tool: ${tools.find((t) => t.id === tool())!.label}`}</Text>
          </View>
        </View>
      </Split>
    </View>
  );
}

mount(App);
