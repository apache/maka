// A case of the API's test suite (docs/dev/compatibility.md): the rich text
// editor's session API of `nsh/base` without a view: schemas
// (`defineSchema`, `starterSchema` and `RichSchema`'s members), editors
// (`createRichEditor` with every plugin factory, `RichEditorSession`'s
// members), every command factory run and asked about, JSON transactions,
// `dispatchTransaction` taking over, and a `RichEditorPlugin`'s hooks.
// Each line shows one result; its script checks each.
import { Text, View, signal } from "nsh";
import {
  RichEditorPlugin,
  RichEditorSession,
  RichSchema,
  baseKeymap,
  chain,
  command,
  createRichEditor,
  defineSchema,
  first,
  history,
  inputRules,
  insertContent,
  insertText,
  keymap,
  lift,
  liftListItem,
  markRule,
  markdown,
  markdownRules,
  redo,
  selectAll,
  setBlockType,
  setMark,
  setNodeAttribute,
  setNodeSelection,
  setTextSelection,
  sinkListItem,
  splitListItem,
  starterKeymap,
  starterKit,
  starterSchema,
  textRule,
  textblockRule,
  toggleMark,
  typographyRules,
  undo,
  unsetMark,
  wrapIn,
  wrapInList,
  wrappingRule,
} from "nsh/base";

function App() {
  const lines = signal<string[]>([]);
  const keys = signal("Keys: none");
  const updates = signal(0);

  const run = () => {
    const out: string[] = [];
    const step = (name: string, f: () => string) => {
      try {
        out.push(`${name}: ${f()}`);
      } catch (e) {
        out.push(`${name}: threw ${(e as Error).message}`);
      }
    };

    const schema = starterSchema();
    const tiny = defineSchema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} } });
    step("Schema", () => `${tiny.nodes.join(",")} ${tiny.marks.length} ${tiny.topNode}`);
    step("Parse", () => `${tiny.parse("a\nb").content?.length} ${schema.parseMarkdown("# H").content?.[0].type}`);
    step("Serialize", () => tiny.serialize(tiny.parse("a\nb"), "text").replace("\n", "|"));
    step("Check", () => schema.check({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "x" }] }] }).content?.[0].attrs?.level as unknown as string);

    const watch = new RichEditorPlugin("watch")
      .filterTransaction((tr) => tr.meta?.block !== true)
      .appendTransaction(() => null)
      .captureKeys(["Mod-k"], (key) => keys.set(`Keys: ${key}`));
    watch.capturing = true;
    const editor = createRichEditor({
      schema,
      content: "# Title\n\nHello world",
      format: "markdown",
      plugins: [
        history({ depth: 50, newGroupDelay: 0 }),
        keymap({ "Mod-b": toggleMark("bold") }),
        baseKeymap(),
        starterKeymap(),
        inputRules([
          ...markdownRules(),
          ...typographyRules(),
          textRule("->$", "→"),
          markRule("==([^=]+)==$", "code"),
          wrappingRule("^\\s*>>\\s$", "blockquote"),
          textblockRule("^~~~$", "codeBlock"),
        ]),
        markdown({ paste: true }),
        watch,
      ],
    });
    editor.subscribe(() => updates.set(updates() + 1));

    step("Plugin", () => `${watch.key} ${watch.capturing}`);
    step("Classes", () => `${schema instanceof RichSchema} ${editor instanceof RichEditorSession}`);
    step("Blocks", () => `${editor.doc.content?.length} ${editor.isEmpty}`);
    step("Heading", () => `${editor.run(setTextSelection(2))} ${editor.isActive("heading", { level: 1 })}`);
    step("Bold", () => {
      editor.run(setTextSelection(8, 13));
      return `${editor.run(toggleMark("bold"))} ${editor.isActive("bold")} ${editor.can(toggleMark("bold"))}`;
    });
    step("Undo", () => `${editor.run(undo())} ${editor.isActive("bold")} ${editor.redoDepth}`);
    step("Redo", () => `${editor.run(redo())} ${editor.isActive("bold")}`);
    step("Marks", () => {
      editor.run(unsetMark("bold"));
      editor.run(setMark("italic"));
      return `${editor.isActive("bold")} ${editor.isActive("italic")}`;
    });
    step("Block", () => {
      const h2 = editor.run(setBlockType("heading", { level: 2 })) && editor.isActive("heading", { level: 2 });
      editor.run(setBlockType("paragraph"));
      return `${h2} ${editor.isActive("paragraph")}`;
    });
    step("Quote", () => {
      const wrapped = editor.run(wrapIn("blockquote")) && editor.isActive("blockquote");
      editor.run(lift());
      return `${wrapped} ${editor.isActive("blockquote")}`;
    });
    step("List", () => {
      const listed = editor.run(wrapInList("bulletList")) && editor.isActive("bulletList");
      const sink = editor.can(sinkListItem("listItem"));
      editor.run(liftListItem("listItem"));
      return `${listed} ${sink} ${editor.isActive("bulletList")}`;
    });
    step("Chain", () => `${editor.run(chain([selectAll(), insertText("Replaced")]))} ${editor.getText()}`);
    step("First", () => `${editor.run(first([wrapInList("orderedList"), selectAll()]))} ${editor.isActive("orderedList")}`);
    step("Filter", () => {
      const before = editor.revision;
      editor.dispatch({ steps: [{ stepType: "replace", from: 3, to: 3, slice: { content: [{ type: "text", text: "X" }] } }], meta: { block: true } });
      return `${editor.revision === before}`;
    });
    step("Decorations", () => {
      editor.setDecorations("watch", [{ from: 3, to: 5, kind: "inline", attrs: { class: "hl" } }]);
      return "set";
    });
    step("State", () => `${editor.state.selection.type} ${typeof editor.state.doc.type} ${editor.undoDepth > 0} ${editor.composing}`);

    const other = createRichEditor({ content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "A" }] }], plugins: [starterKit()] });
    step("Attr", () => {
      other.run(setNodeAttribute(0, "level", 3));
      other.run(setTextSelection(1));
      return `${other.isActive("heading", { level: 3 })}`;
    });
    step("Split", () => `${other.run(command("splitBlock"))} ${other.doc.content?.length}`);
    step("Content", () => {
      other.setContent("Plain line");
      const plain = other.getText();
      other.setContent("**b**", "markdown");
      return `${plain} ${other.getMarkdown().trim()}`;
    });
    step("Insert", () => {
      other.run(setTextSelection(1));
      other.run(insertContent("x"));
      other.insertContent("y");
      return other.getText();
    });
    step("Dispatch", () => {
      other.dispatch({ steps: [], selection: { type: "all" } });
      return `${other.selection.type} ${other.textBetween(0, 3)}`;
    });

    const rules = createRichEditor({ content: [{ type: "paragraph" }, { type: "horizontalRule" }], plugins: [] });
    step("Node", () => `${rules.run(setNodeSelection(2))} ${rules.selection.type}`);

    const items = createRichEditor({ content: "- one", format: "markdown", plugins: [] });
    step("Items", () => {
      items.run(setTextSelection(6));
      return `${items.run(splitListItem("listItem"))} ${items.can(sinkListItem("listItem"))}`;
    });

    const taken = createRichEditor({ content: "a", plugins: [] });
    let seen = 0;
    taken.dispatchTransaction = (tr) => {
      seen += 1;
      taken.applyTransaction(tr);
    };
    step("Takeover", () => `${taken.run(insertText("b"))} ${seen} ${taken.getText()}`);
    taken.dispatchTransaction = null;

    step("Empty", () => `${createRichEditor().isEmpty}`);
    step("Error", () => {
      try {
        createRichEditor({ schema: tiny, plugins: [keymap({ "Mod-b": toggleMark("bold") })] });
        return "none";
      } catch {
        return "thrown";
      }
    });
    lines.set(out);
  };

  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <View onPress={run}><Text>RunSession</Text></View>
      <Text>{keys()}</Text>
      <Text>{`Updates: ${updates() > 0}`}</Text>
      {() => lines().map((line) => <Text>{line}</Text>)}
    </View>
  );
}

export default App;
