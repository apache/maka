import { mount, signal, Text, View } from "nsh";
import {
  RichEditor,
  RichEditorPlugin,
  StarterKit,
  createRichEditor,
  defineExtension,
  insertContent,
  insertText,
} from "nsh/base";

// An editor whose paste goes through the app's hooks (ProseMirror's
// `transformPasted` and `handlePaste` on a `RichEditorPlugin`), as a
// community editor's does: Word's list paragraphs become a list from the
// clipboard's HTML, a video link pasted on its own a video card, and
// pasted text is upper-cased. HTML a Google Doc copied is cleaned up and
// pasted on with `pasteHTML` (read by the paste's rules, so a figure
// stays one), text marked `plain:` with `pasteText`: neither asks the hooks
// again. `ChangeOnce` makes the next `transformPasted` change the
// document while the paste waits for it.
const log = signal<string[]>([]);
const note = (line: string) => log.set([...log(), line]);
let changeOnce = false;

const Video = defineExtension({
  name: "video",
  node: { group: "block", atom: true, attrs: { src: { default: "" } } },
});

// A picture with its caption as its content, as a long-form editor's:
// `isolating`, so a paste keeps it whole (ProseMirror's rule), where
// `insertContent` opens it and keeps only the caption.
const Figure = defineExtension({
  name: "figure",
  node: {
    group: "block",
    content: "inline*",
    isolating: true,
    attrs: { src: { default: "" } },
    parseDOM: [{ tag: "figure", getAttrs: { src: "data-src" }, contentElement: "figcaption" }],
    toDOM: ["figure", { "data-src": { attr: "src" } }, ["figcaption", 0]],
  },
});

type Nodes = { type: string; text?: string; content?: Nodes }[] | undefined;
const upper = (nodes: Nodes): Nodes => nodes?.map((n) => ({ ...n, text: n.text?.toUpperCase(), content: upper(n.content) }));

function App() {
  let editor: ReturnType<typeof createRichEditor> | undefined;
  const paste = new RichEditorPlugin("paste")
    .transformPasted((slice) => {
      note("transform");
      if (changeOnce && editor) {
        changeOnce = false;
        editor.run(insertText("typed "));
      }
      return { ...slice, content: upper(slice.content as Nodes) as typeof slice.content };
    })
    .handlePaste((_slice, clipboard) => {
      note("handle");
      if (!editor) return false;
      // Google Docs wraps what it copies in a `<b id="docs-internal-guid-…">`.
      const docs = /^<b id="docs-internal-guid-[^"]*">([\s\S]*)<\/b>$/.exec(clipboard.html);
      if (docs) return editor.pasteHTML(docs[1]);
      if (clipboard.text.startsWith("plain:")) return editor.pasteText(clipboard.text.slice("plain:".length));
      // Word marks its list items as paragraphs with a `·` of their own.
      const items = [...clipboard.html.matchAll(/<p class="MsoListParagraph">·\s*([^<]*)<\/p>/g)].map((m) => m[1]);
      if (items.length) {
        editor.run(
          insertContent({
            type: "bulletList",
            content: items.map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })),
          }),
        );
        return true;
      }
      const link = /^https:\/\/(www\.youtube\.com|www\.bilibili\.com)\/\S+$/.exec(clipboard.text.trim());
      if (!link) return false;
      editor.run(insertContent({ type: "video", attrs: { src: link[0] } }));
      return true;
    });
  editor = createRichEditor({ extensions: [StarterKit, Video, Figure], plugins: [paste] });
  const doc = signal("");
  const read = () =>
    (editor?.getJSON().content ?? [])
      .map((n: { type: string; attrs?: { src?: string }; content?: { type: string }[] }) =>
        n.type === "video" || n.type === "figure" ? `${n.type} ${n.attrs?.src}` : n.type,
      )
      .join(",");
  doc.set(read());
  editor.on("transaction", () => doc.set(read()));
  return (
    <View class="flex-1 pt-16 px-4 gap-2">
      <Text>{`doc: ${doc()}`}</Text>
      <Text>{`log: ${log().join(" ")}`}</Text>
      <Text testID="change-once" onPress={() => (changeOnce = true)}>
        ChangeOnce
      </Text>
      <RichEditor editor={editor} testID="editor" class="h-60 text-foreground" />
    </View>
  );
}

mount(App);
