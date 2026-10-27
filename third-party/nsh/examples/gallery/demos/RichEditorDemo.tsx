import { Overlay, signal, Text, View } from "nsh";
import {
  RichEditor,
  RichEditorPlugin,
  type RichCommand,
  type RichEditorSession,
  StarterKit,
  command,
  createRichEditor,
  redo,
  undo,
} from "nsh/base";
import { colors, mono, Segmented } from "../ui";
import { IconButton, ToggleGroup, type ToggleItem, ToolbarSeparator } from "./RichEditorUi";
import { createLinkMenu, LinkBubble, type LinkMenu } from "./RichEditorLink";

// `nsh/base`'s `RichEditor` renders a session the app makes with
// `createRichEditor` from Tiptap's extensions: the state, the commands and
// the plugins run in Rust, so typing, key bindings and Markdown shortcuts
// never wait for JS. What is around it is the app's: the toolbar runs
// Tiptap's commands and asks the session which apply and which are
// active, the bubble menu edits the link under the caret, and the zoom
// button gives the document the whole screen.

const DOC = `# Release notes

Type **Markdown** as you go: \`#\` and a space makes a heading, \`-\` a list, \`1.\` a numbered one, \`>\` a quote.

- Lists split on Enter
- Tab indents an item, Shift-Tab outdents it
  - The list buttons change every level at once
  - And take the selected items out of every level

Links open a menu under the caret: read the [NSH documentation](https://github.com/longbridge/nsh), edit it, or remove it. Select text and press Mod-K to link it.

> Select text and use the toolbar, or Mod-B and Mod-I.

## Details

Drag to select past the editor's edge and the document scrolls along. The zoom button in the toolbar gives the editor the whole screen.

1. Undo and redo keep every step
2. The document is Markdown when you switch to it below
3. Code, quotes and rules are blocks of their own

---

\`\`\`
const editor = createRichEditor({ extensions: [StarterKit] });
\`\`\`
`;

// --- The toolbar ----------------------------------------------------------

type Block = "paragraph" | "h1" | "h2" | "h3" | "code";
type Mark = "bold" | "italic" | "strike" | "code" | "link";
type Wrap = "bullet" | "ordered" | "task" | "quote";

const BLOCKS: ToggleItem<Block>[] = [
  { value: "paragraph", icon: "pilcrow", label: "Text" },
  { value: "h1", icon: "heading-1", label: "Heading 1" },
  { value: "h2", icon: "heading-2", label: "Heading 2" },
  { value: "h3", icon: "heading-3", label: "Heading 3" },
  { value: "code", icon: "square-code", label: "Code block" },
];

const MARKS: ToggleItem<Mark>[] = [
  { value: "bold", icon: "bold", label: "Bold" },
  { value: "italic", icon: "italic", label: "Italic" },
  { value: "strike", icon: "strikethrough", label: "Strikethrough" },
  { value: "code", icon: "code", label: "Inline code" },
  { value: "link", icon: "link", label: "Link" },
];

const WRAPS: ToggleItem<Wrap>[] = [
  { value: "bullet", icon: "list", label: "Bulleted list" },
  { value: "ordered", icon: "list-ordered", label: "Numbered list" },
  { value: "task", icon: "list-todo", label: "Task list" },
  { value: "quote", icon: "text-quote", label: "Quote" },
];

/** What a block toggle runs (Tiptap's commands): pressed sets that type, released goes back to text. */
function blockCommand(block: Block, pressed: boolean): RichCommand {
  if (!pressed || block === "paragraph") return command("setParagraph");
  if (block === "code") return command("toggleCodeBlock");
  return command("toggleHeading", { level: Number(block[1]) });
}

const MARK_COMMANDS: Record<Exclude<Mark, "link">, string> = {
  bold: "toggleBold",
  italic: "toggleItalic",
  strike: "toggleStrike",
  code: "toggleCode",
};

/**
 * What a list or quote toggle runs: Tiptap's toggles, which wrap the
 * blocks, change a list of another kind (every level of it) or take the
 * blocks out.
 */
const WRAP_COMMANDS: Record<Wrap, string> = {
  bullet: "toggleBulletList",
  ordered: "toggleOrderedList",
  task: "toggleTaskList",
  quote: "toggleBlockquote",
};

const WRAP_TYPES: Record<Wrap, string> = { bullet: "bulletList", ordered: "orderedList", task: "taskList", quote: "blockquote" };

/** The toolbar: undo and redo, the block type, the marks and links, lists and quotes, indents, the zoom. */
function Toolbar(props: { editor: RichEditorSession; revision: number; link: LinkMenu; zoomed: boolean; onZoom: () => void }) {
  const editor = props.editor;
  // Read again on every change of the session.
  const on = (name: string, attrs?: Record<string, unknown>) => {
    void props.revision;
    return editor.isActive(name, attrs);
  };
  const can = (cmd: RichCommand) => {
    void props.revision;
    return editor.can(cmd);
  };
  const run = (cmd: RichCommand) => {
    editor.run(cmd);
    editor.focus();
  };
  const block = (): Block[] => {
    if (on("codeBlock")) return ["code"];
    for (const level of [1, 2, 3] as const) if (on("heading", { level })) return [`h${level}`];
    return on("paragraph") ? ["paragraph"] : [];
  };
  const marks = (): Mark[] => MARKS.map((m) => m.value).filter((m) => on(m));
  // The innermost list's kind (what the list buttons change), and a quote.
  const wraps = (): Wrap[] => {
    void props.revision;
    const lists = (["bullet", "ordered", "task"] as const)
      .map((kind) => ({ kind, found: editor.findParentNode(WRAP_TYPES[kind]) as { depth: number } | null }))
      .filter((l) => l.found)
      .sort((a, b) => b.found!.depth - a.found!.depth);
    return [...lists.slice(0, 1).map((l) => l.kind), ...(on("blockquote") ? (["quote"] as const) : [])];
  };
  const indent = command("sinkListItem", { name: "listItem" });
  const outdent = command("liftListItem", { name: "listItem" });
  return (
    <View testID="toolbar" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 6, columnGap: 4 }}>
      <IconButton icon="undo-2" label="Undo" disabled={!can(undo())} onPress={() => run(undo())} />
      <IconButton icon="redo-2" label="Redo" disabled={!can(redo())} onPress={() => run(redo())} />
      <ToolbarSeparator />
      <ToggleGroup
        type="single"
        items={BLOCKS.map((item) => ({ ...item, disabled: !can(blockCommand(item.value, true)) }))}
        value={block()}
        onToggle={(value, pressed) => run(blockCommand(value, pressed))}
      />
      <ToolbarSeparator />
      <ToggleGroup
        type="multiple"
        items={MARKS.map((item) => ({ ...item, disabled: item.value !== "link" && !can(command(MARK_COMMANDS[item.value as Exclude<Mark, "link">])) }))}
        value={marks()}
        onToggle={(value) => (value === "link" ? props.link.edit() : run(command(MARK_COMMANDS[value])))}
      />
      <ToolbarSeparator />
      <ToggleGroup
        type="multiple"
        items={WRAPS.map((item) => ({ ...item, disabled: !can(command(WRAP_COMMANDS[item.value])) }))}
        value={wraps()}
        onToggle={(value) => run(command(WRAP_COMMANDS[value]))}
      />
      <IconButton icon="list-indent-decrease" label="Outdent" disabled={!can(outdent)} onPress={() => run(outdent)} />
      <IconButton icon="list-indent-increase" label="Indent" disabled={!can(indent)} onPress={() => run(indent)} />
      <IconButton icon="minus" label="Divider" disabled={!can(command("setHorizontalRule"))} onPress={() => run(command("setHorizontalRule"))} />
      <View style={{ flex: 1 }} />
      <IconButton icon={props.zoomed ? "minimize-2" : "maximize-2"} label={props.zoomed ? "Exit zoom" : "Zoom"} onPress={props.onZoom} />
    </View>
  );
}

// --- The document ---------------------------------------------------------

/** The document's look, by part, node type (and heading level) and mark. */
const documentClasses = {
  // The room around the text is the content's padding, inside the scroll
  // view: its scroll bar runs along the editor's edge.
  content: "gap-3 px-6 py-5",
  placeholder: "text-muted-foreground",
  listMarker: "text-muted-foreground",
  taskCheckbox: "size-4 mr-2 mt-1 rounded border border-border",
  nodes: {
    paragraph: "leading-relaxed",
    "heading[level=1]": "text-3xl font-bold tracking-tight",
    "heading[level=2]": "text-2xl font-semibold tracking-tight",
    "heading[level=3]": "text-xl font-semibold",
    blockquote: "border-l-4 border-border pl-4 text-muted-foreground italic",
    codeBlock: "font-mono text-sm bg-muted rounded-lg px-4 py-3",
    bulletList: "gap-1.5 pl-6",
    orderedList: "gap-1.5 pl-6",
    taskList: "gap-1.5",
    horizontalRule: "h-px bg-border my-3",
  },
  marks: {
    bold: "font-bold",
    italic: "italic",
    code: "font-mono text-sm bg-muted rounded px-1",
    link: "text-primary underline",
    strike: "line-through",
  },
};

export function RichEditorDemo() {
  // Mod-K opens the link field, as in most editors.
  const keys = new RichEditorPlugin("linkKey");
  const editor = createRichEditor({ extensions: [StarterKit], plugins: [keys], content: DOC, format: "markdown" });
  const revision = signal(editor.revision);
  const source = signal(editor.getMarkdown());
  const text = signal(editor.getText());
  editor.subscribe((r) => {
    revision.set(r);
    source.set(editor.getMarkdown());
    text.set(editor.getText());
  });
  const link = createLinkMenu(editor, revision);
  keys.captureKeys(["Mod-k"], () => link.edit());
  keys.capturing = true;

  const mode = signal<"edit" | "markdown">("edit");
  const zoomed = signal(false);
  const words = () => text().split(/\s+/).filter(Boolean).length;
  // The editor and its bars; zoomed, they cover the whole window.
  const panel = () => (
    <View
      testID="document"
      style={{
        flex: 1,
        minHeight: 360,
        borderRadius: zoomed() ? 0 : 12,
        borderWidth: zoomed() ? 0 : 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      <View style={{ paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.inset }}>
        <Toolbar editor={editor} revision={revision()} link={link} zoomed={zoomed()} onZoom={() => zoomed.set(!zoomed())} />
      </View>
      <If
        when={mode() === "edit"}
        else={
          <View style={{ flex: 1, paddingHorizontal: 24, paddingVertical: 20 }}>
            <Text testID="markdown-source" style={{ fontFamily: mono, fontSize: 13, lineHeight: 20, color: colors.text }}>
              {source()}
            </Text>
          </View>
        }
      >
        <RichEditor
          testID="markdown-editor"
          editor={editor}
          accessibilityLabel="Document"
          placeholder="Write something…"
          style={{ flex: 1 }}
          classes={documentClasses}
          bubbleMenu={link.mode() === "closed" ? undefined : <LinkBubble menu={link} />}
          bubbleMenuPlacement="bottom"
        />
      </If>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderTopWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>
          {`${words()} words · ${text().length} characters`}
        </Text>
        <View style={{ width: 180 }}>
          <Segmented
            size="small"
            options={[
              { value: "edit", label: "Edit" },
              { value: "markdown", label: "Markdown" },
            ]}
            value={mode()}
            onChange={(value) => mode.set(value)}
          />
        </View>
      </View>
    </View>
  );
  return (
    <If when={zoomed()} else={<View style={{ flex: 1, padding: 16 }}>{panel()}</View>}>
      <Overlay style={{ top: 0, left: 0, right: 0, bottom: 0 }} onCancel={() => zoomed.set(false)}>
        {panel()}
      </Overlay>
    </If>
  );
}
