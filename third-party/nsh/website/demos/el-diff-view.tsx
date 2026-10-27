import { mount, signal, Text, View } from "nsh";
import { DiffView, type DiffViewRef } from "nsh/base";
import { button, buttonText, desktop, Log, Panel, Segmented, size, Split, ui, wide } from "./palette";

const OLD = `fn greet(name: &str) -> String {
    format!("Hello, {}", name)
}

fn main() {
    let names = vec!["Ada", "Grace"];
    for name in names {
        println!("{}", greet(name));
    }
}
`;

const NEW = `fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

fn main() {
    let names = ["Ada", "Grace", "Linus"];
    for name in names {
        println!("{}", greet(name));
    }
}
`;

// The texts are the app's: a change reverted or kept is reported
// (`onChange`) and set back as `oldValue` and `newValue`.
function App() {
  const layout = signal<"split" | "unified">(desktop ? "split" : "unified");
  const inline = signal<"wordAlt" | "char" | "none">("wordAlt");
  const oldValue = signal(OLD);
  const newValue = signal(NEW);
  const stats = signal("");
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  let diff: DiffViewRef | undefined;
  const count = async () => {
    const s = await diff?.stats();
    stats.set(s ? `+${s.added} −${s.deleted} · ${s.hunks} changes` : "");
  };

  const action = (label: string, onPress: () => void, primary?: boolean) => (
    <View onPress={onPress} role="button" accessibilityLabel={label} {...button(primary ? "accent" : "secondary", { size: "sm" })}>
      <Text style={buttonText(primary ? "accent" : "secondary")}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>diff view</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click Revert or Keep on a change, or a line number" : "Tap Revert or Keep on a change, or a line number"}
      </Text>

      <Split
        grow
        width={680}
        inspector={
          <>
            <Segmented label="layout" options={["split", "unified"] as const} value={layout()} onChange={(v) => layout.set(v)} />
            <Segmented label="inline" options={["wordAlt", "char", "none"] as const} value={inline()} onChange={(v) => inline.set(v)} />
            <Panel title="stats">
              <Text style={{ fontSize: 13, fontVariant: ["tabular-nums"], color: ui().text }}>{stats()}</Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                <View
                  onPress={() => {
                    oldValue.set(OLD);
                    newValue.set(NEW);
                    setTimeout(count, 0);
                  }}
                  role="button"
                  {...button("secondary", { size: "sm" })}
                >
                  <Text style={buttonText()}>Reset</Text>
                </View>
              </View>
            </Panel>
            <Log title="events" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 360 : 320, ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <DiffView
            ref={(r) => {
              diff = r;
              count();
            }}
            oldValue={oldValue()}
            newValue={newValue()}
            language="rust"
            layout={layout()}
            inline={inline()}
            contextLines={1}
            renderHunkActions={(hunk) => (
              <View style={{ flexDirection: "row", gap: 4 }}>
                {action("Revert", () => diff?.revertHunk(hunk.index))}
                {action("Keep", () => diff?.acceptHunk(hunk.index), true)}
              </View>
            )}
            onChange={(change) => {
              oldValue.set(change.oldValue);
              newValue.set(change.newValue);
              log(`onChange: ${change.newValue.split("\n").length - 1} lines`);
              count();
            }}
            onLineNumberPress={(line) => log(`onLineNumberPress: ${line.side} ${line.line + 1}`)}
            style={{ flex: 1 }}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
