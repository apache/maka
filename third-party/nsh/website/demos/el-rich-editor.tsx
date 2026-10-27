import { mount, signal, Text, View } from "nsh";
import { RichEditor, StarterKit, command, createRichEditor, redo, undo } from "nsh/base";
import { button, buttonText, desktop, Log, Panel, Split, ui, wide } from "./palette";

const CONTENT = `# A document

Type **Markdown** as you go: \`# \` makes a heading, \`- \` a list, \`[ ] \` a task.

- Select text and press Bold
- Undo and redo keep every step
`;

// The session owns the document; the view renders it and turns input into
// transactions. The toolbar runs Tiptap's named commands on the session.
function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: CONTENT });
  const markdown = signal(editor.getMarkdown());
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  editor.subscribe(() => markdown.set(editor.getMarkdown()));
  editor.on("focus", () => log("focus"));
  editor.on("blur", () => log("blur"));

  const action = (label: string, run: () => void) => (
    <View onPress={run} role="button" accessibilityLabel={label} {...button("secondary", { size: "sm" })}>
      <Text style={buttonText()}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>rich editor</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Click into the document and type; Cmd/Ctrl+B makes bold" : "Tap into the document and type"}
      </Text>

      <Split
        grow
        width={640}
        inspector={
          <>
            <Panel title="markdown">
              <Text style={{ fontSize: 12, fontFamily: "monospace", color: ui().text }}>{markdown()}</Text>
            </Panel>
            <Log title="events" lines={events()} minHeight={72} />
          </>
        }
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {action("Bold", () => editor.run(command("toggleBold")))}
          {action("Italic", () => editor.run(command("toggleItalic")))}
          {action("Heading", () => editor.run(command("toggleHeading", { level: 2 })))}
          {action("List", () => editor.run(command("toggleBulletList")))}
          {action("Task", () => editor.run(command("toggleTaskList")))}
          {action("Undo", () => editor.run(undo))}
          {action("Redo", () => editor.run(redo))}
        </View>
        <View style={{ height: wide() ? 360 : 300, ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <RichEditor
            editor={editor}
            accessibilityLabel="Document"
            placeholder="Write something"
            classes={{ content: "p-4", taskCheckbox: "size-4 mr-2 mt-1 rounded border border-border" }}
            style={{ flex: 1 }}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
