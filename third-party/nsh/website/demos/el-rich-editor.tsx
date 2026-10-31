import { mount, signal, Text, View } from "nsh";
import { RichEditor, StarterKit, command, createRichEditor, redo, undo } from "nsh/base";
import { button, buttonText, desktop, Log, Panel, Split, ui, wide } from "./palette";

const CONTENT = `# A document

Type **Markdown** as you go: \`#\` makes a heading, \`-\` a list, \`[ ]\` a task, each followed by a space.

- Select text and press Bold
- Undo and redo keep every step
`;

// The session owns the document; the view renders it and turns input into
// transactions. The toolbar runs Tiptap's named commands on the session.
function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: CONTENT, format: "markdown" });
  const markdown = signal(editor.getMarkdown());
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  editor.on("revision", () => markdown.set(editor.getMarkdown()));
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
            classes={CLASSES}
            style={{ flex: 1 }}
          />
        </View>
      </Split>
    </View>
  );
}

/** The document's look: NSH's editor draws nothing of its own. */
const CLASSES = {
  content: "p-4 gap-3",
  taskCheckbox: "size-4 mr-2 mt-0.5 rounded border border-border checked:bg-primary checked:border-primary",
  listMarker: "text-muted-foreground",
  nodes: {
    "heading[level=1]": "text-2xl font-bold",
    "heading[level=2]": "text-xl font-semibold",
    "heading[level=3]": "text-lg font-semibold",
    blockquote: "border-l-4 border-border pl-3 text-muted-foreground",
    codeBlock: "font-mono text-sm bg-muted rounded-md px-3 py-2",
    bulletList: "gap-1 pl-5",
    orderedList: "gap-1 pl-5",
    taskList: "gap-1",
    taskItem: "flex-row",
    horizontalRule: "h-px bg-border my-2",
  },
  marks: {
    bold: "font-semibold",
    italic: "italic",
    strike: "line-through",
    code: "font-mono text-sm bg-muted rounded px-1",
    link: "text-primary underline",
  },
};

mount(App);
