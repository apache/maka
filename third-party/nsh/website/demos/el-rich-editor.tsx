import { mount, signal, Text, View } from "nsh";
import { Button, RichEditor, type RichCommand, StarterKit, command, createRichEditor, redo, Toggle, ToggleGroup, Toolbar, ToolbarSeparator, undo } from "nsh/base";
import { desktop, Icon, Log, Panel, Split, toggleGlyph, toggleLabel, toggleLook, toolbarRule, toolbarTrack, ui, wide, sectionSurface, richEditorClasses } from "./palette";

const CONTENT = `# A document

Type **Markdown** as you go: \`#\` makes a heading, \`-\` a list, \`[ ]\` a task, each followed by a space.

- Select text and press Bold
- Undo and redo keep every step
`;

/** The toolbar's formats: small, each its label. */
const tool = { size: "small", text: true } as const;
/** Its actions: small and square, an icon each, so the bar fits a phone's width. */
const iconTool = { size: "small" } as const;

// The session owns the document; the view renders it and turns input into
// transactions. The toolbar runs Tiptap's named commands on the session; its
// toggles show what is active at the selection, its buttons what can run.
function App() {
  const editor = createRichEditor({ extensions: [StarterKit], content: CONTENT, format: "markdown" });
  const markdown = signal(editor.getMarkdown());
  const revision = signal(0);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  editor.on("revision", ({ revision: r }) => {
    revision.set(r);
    markdown.set(editor.getMarkdown());
  });
  editor.on("focus", () => log("focus"));
  editor.on("blur", () => log("blur"));

  // Read again on every change of the session, the selection's included.
  const active = (name: string, attrs?: Record<string, unknown>) => (revision(), editor.isActive(name, attrs));
  const can = (cmd: RichCommand) => (revision(), editor.can(cmd));
  const run = (cmd: RichCommand) => {
    editor.run(cmd);
    editor.focus();
  };

  /** A format that is on or off at the selection: a `Toggle`. */
  const format = (label: string, on: () => boolean, cmd: RichCommand) => (
    <Toggle pressed={on()} onChange={() => run(cmd)} {...toggleLook(tool)}>
      <Text style={toggleLabel(on, tool)}>{label}</Text>
    </Toggle>
  );
  /** An action (undo, redo): a `Button` in the same look, its icon named
   * for screen readers, enabled while it can run. Redo is undo's arrow
   * mirrored. */
  const action = (label: string, cmd: () => RichCommand, mirrored?: boolean) => (
    <Button
      accessibilityLabel={label}
      disabled={!can(cmd())}
      onPress={() => run(cmd())}
      {...toggleLook({ ...iconTool, disabled: () => !can(cmd()) })}
    >
      <View style={mirrored ? { transform: [{ scaleX: -1 }] } : undefined}>
        <Icon name="undo" {...toggleGlyph(() => false, iconTool)} />
      </View>
    </Button>
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
        <Toolbar accessibilityLabel="Formatting" style={{ ...toolbarTrack(), alignSelf: "flex-start", flexWrap: "wrap" }}>
          <ToggleGroup style={{ flexDirection: "row", gap: 2 }}>
            {format("Bold", () => active("bold"), command("toggleBold"))}
            {format("Italic", () => active("italic"), command("toggleItalic"))}
          </ToggleGroup>
          <ToolbarSeparator style={toolbarRule()} />
          <ToggleGroup style={{ flexDirection: "row", gap: 2 }}>
            {format("Heading", () => active("heading", { level: 2 }), command("toggleHeading", { level: 2 }))}
            {format("List", () => active("bulletList"), command("toggleBulletList"))}
            {format("Task", () => active("taskList"), command("toggleTaskList"))}
          </ToggleGroup>
          <ToolbarSeparator style={toolbarRule()} />
          {action("Undo", undo)}
          {action("Redo", redo, true)}
        </Toolbar>
        <View style={{ height: wide() ? 360 : 300, ...sectionSurface(), overflow: "hidden" }}>
          <RichEditor
            editor={editor}
            accessibilityLabel="Document"
            placeholder="Write something"
            classes={richEditorClasses}
            style={{ flex: 1 }}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
