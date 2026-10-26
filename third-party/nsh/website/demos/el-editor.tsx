import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Editor, type EditorDiagnostic, type EditorRef, type EditorSearchResult } from "nsh/base";
import { button, buttonText, desktop, field, Log, Panel, Segmented, size, Split, ui, wide } from "./palette";

const SAMPLES = {
  rust: `/// The n-th Fibonacci number.
fn fib(n: u64) -> u64 {
    match n {
        0 | 1 => n,
        _ => fib(n - 1) + fib(n - 2),
    }
}

fn main() {
    let unused = 0;
    for n in 0..10 {
        println!("fib({n}) = {}", fib(n));
    }
}
`,
  typescript: `type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.r ** 2;
    case "square":
      return shape.side ** 2;
  }
}

console.log(area({ kind: "circle", r: 2 }));
`,
  json: `{
  "name": "my-app",
  "entry": "App.tsx",
  "capabilities": ["network"]
}
`,
} as const;

type Language = keyof typeof SAMPLES;

// A problem to mark in each file, as a linter would report it.
const PROBLEMS: Record<Language, EditorDiagnostic[]> = {
  rust: [{ range: { start: { line: 9, column: 8 }, end: { line: 9, column: 14 } }, severity: "warning", message: "unused variable" }],
  typescript: [],
  json: [],
};

// The text is the editor's own (`defaultValue`), an editor per language so
// each keeps its own undo; the app passes what to find (`search`) and reads
// the caret and the matches from the events.
function App() {
  const language = signal<Language>("rust");
  const wrap = signal<"Scroll" | "Wrap">("Scroll");
  const query = signal("");
  const caret = signal("1:1");
  const found = signal<EditorSearchResult>({ count: 0 });
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  let editor: EditorRef | undefined;

  const action = (label: string, onPress: () => void) => (
    <View onPress={onPress} role="button" {...button("secondary", { size: "sm" })}>
      <Text style={buttonText()}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>editor</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click into the code and type; Alt-click adds a caret, Cmd/Ctrl+D the next match" : "Tap into the code and type"}
      </Text>

      <Split
        grow
        width={640}
        inspector={
          <>
            <Segmented label="language" options={["rust", "typescript", "json"] as const} value={language()} onChange={(v) => language.set(v)} />
            <Segmented label="long lines" options={["Scroll", "Wrap"] as const} value={wrap()} onChange={(v) => wrap.set(v)} />
            <Panel title="find">
              <Input
                value={query()}
                onChange={(v) => query.set(v)}
                onSubmit={() => editor?.run("findNext")}
                submitBehavior="submit"
                placeholder="fib"
                accessibilityLabel="Find"
                autoCapitalize="none"
                autoCorrect={false}
                {...field({ style: { height: size.controlSm, paddingVertical: 0 } })}
              />
              <Text style={{ fontSize: 13, fontVariant: ["tabular-nums"], color: ui().text }}>
                {query() ? (found().error ?? `${found().current == null ? "–" : found().current! + 1} of ${found().count}`) : "–"}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {action("Next", () => editor?.run("findNext"))}
                {action("Undo", () => editor?.run("undo"))}
              </View>
            </Panel>
            <Panel title="caret">
              <Text style={{ fontSize: 13, fontVariant: ["tabular-nums"], color: ui().text }}>{caret()}</Text>
            </Panel>
            <Log title="events" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 380 : 300, ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          {() => {
            const lang = language();
            return (
              <Editor
                ref={(r) => (editor = r)}
                defaultValue={SAMPLES[lang]}
                language={lang}
                softWrap={wrap() === "Wrap"}
                search={{ query: query() }}
                diagnostics={PROBLEMS[lang]}
                accessibilityLabel="Code"
                onChange={(v) => log(`onChange: ${v.length} characters`)}
                onSelectionChange={(selections) => {
                  const head = selections[selections.length - 1].head;
                  caret.set(`${head.line + 1}:${head.column + 1}${selections.length > 1 ? ` (${selections.length} carets)` : ""}`);
                }}
                onSearchChange={(result) => found.set(result)}
                onFocus={() => log("onFocus")}
                onBlur={() => log("onBlur")}
                onLineNumberPress={(line) => log(`onLineNumberPress: ${line + 1}`)}
                onContextMenu={(e) => log(`onContextMenu: ${e.position.line + 1}:${e.position.column + 1}`)}
                style={{ flex: 1 }}
              />
            );
          }}
        </View>
      </Split>
    </View>
  );
}

mount(App);
