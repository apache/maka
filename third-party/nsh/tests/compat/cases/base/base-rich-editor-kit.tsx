// A case of the API's test suite (docs/dev/compatibility.md): the rich text
// editor's extensions of `nsh/base` without a view: the built-in
// extensions' classes (`StarterKit`, `Bold`, ...) with `configure` and
// `extend`, `RichExtension`, `defineExtension`, `richExtension` and
// `createRichEditor({ extensions, editable })`. Each line shows one result;
// its script checks each.
import { Text, View, signal } from "nsh";
import {
  Blockquote,
  Bold,
  BulletList,
  Code,
  CodeBlock,
  Document,
  HardBreak,
  Heading,
  Highlight,
  History,
  HorizontalRule,
  Italic,
  Link,
  ListItem,
  ListKeymap,
  OrderedList,
  Paragraph,
  RichExtension,
  RichImage,
  StarterKit,
  Strike,
  Subscript,
  Superscript,
  TaskItem,
  TaskList,
  TextAlign,
  RichTextStyle,
  TrailingNode,
  Typography,
  Underline,
  command,
  createRichEditor,
  defineExtension,
  insertText,
  richExtension,
  setTextSelection,
  starterSchema,
  textRule,
  toggleMark,
} from "nsh/base";

function App() {
  const lines = signal<string[]>([]);

  const run = () => {
    const out: string[] = [];
    const step = (name: string, f: () => string) => {
      try {
        out.push(`${name}: ${f()}`);
      } catch {
        out.push(`${name}: threw`);
      }
    };
    step("Kit", () => {
      const editor = createRichEditor({ extensions: [StarterKit], content: "Hello" });
      const selected = editor.run(setTextSelection(1, 6));
      const bold = editor.run(command("toggleBold"));
      return `${selected} ${bold} ${editor.isActive("bold")}`;
    });
    step("Configure", () => {
      const editor = createRichEditor({
        extensions: [StarterKit.configure({ bold: false, heading: { levels: [1, 2] } })],
        content: "Title",
      });
      let bold = "ran";
      try {
        editor.can(command("toggleBold"));
      } catch {
        bold = "unknown";
      }
      return `${editor.can(command("toggleHeading", { level: 3 }))} ${editor.can(command("toggleHeading", { level: 2 }))} ${bold}`;
    });
    step("Extension", () => {
      const bold: RichExtension = Bold.configure({});
      return `${bold.name} ${bold.type} ${bold.priority}`;
    });
    step("Extend", () => {
      const underline = Underline.extend({
        priority: 200,
        addKeyboardShortcuts: () => ({ "Mod-Alt-u": toggleMark("underline") }),
      });
      const editor = createRichEditor({
        extensions: [StarterKit.configure({ underline: false }), underline],
      });
      return `${underline.priority} ${underline.name} ${editor.isEditable}`;
    });
    step("Define", () => {
      const shout = defineExtension({
        name: "shout",
        addOptions: () => ({ word: "HEY" }),
        addCommands: (options) => ({ shout: insertText(options.word) }),
        addInputRules: () => [textRule("!!$", "‼")],
        addKeyboardShortcuts: () => ({ "Mod-Alt-h": command("shout") }),
      });
      const editor = createRichEditor({
        extensions: [StarterKit, shout.configure({ word: "HI" })],
        content: "x",
      });
      editor.run(setTextSelection(2));
      editor.run(command("shout"));
      return `${(shout.options as { word: string }).word} ${shout.type} ${editor.getText().trim()}`;
    });
    step("Named", () => {
      const text = richExtension("text").name;
      let missing = "found";
      try {
        richExtension("nope");
      } catch {
        missing = "threw";
      }
      return `${text} ${missing}`;
    });
    step("Editable", () => {
      const editor = createRichEditor({ extensions: [StarterKit], editable: false });
      return `${editor.isEditable}`;
    });
    step("Both", () => {
      createRichEditor({ extensions: [StarterKit], schema: starterSchema() });
      return "made";
    });
    step("Duplicate", () => {
      createRichEditor({ extensions: [StarterKit, Bold] });
      return "made";
    });
    step("Classes", () =>
      [
        StarterKit,
        Document,
        Paragraph,
        Heading,
        Blockquote,
        BulletList,
        OrderedList,
        ListItem,
        TaskList,
        TaskItem,
        CodeBlock,
        HardBreak,
        HorizontalRule,
        RichImage,
        Bold,
        Italic,
        Strike,
        Code,
        Underline,
        Link,
        Highlight,
        Subscript,
        Superscript,
        RichTextStyle,
        TextAlign,
        History,
        TrailingNode,
        Typography,
        ListKeymap,
      ]
        .map((extension) => extension.configure().name)
        .join(","),
    );
    lines.set(out);
  };

  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <View onPress={run}><Text>RunKit</Text></View>
      {() => lines().map((line) => <Text>{line}</Text>)}
    </View>
  );
}

export default App;
