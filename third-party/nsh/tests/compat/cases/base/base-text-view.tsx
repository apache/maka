// A case of the API's test suite (docs/dev/compatibility.md): `TextView`
// of `nsh/base`, a document shown with texts and views: Markdown (a
// heading, a link, a list, a table, code), HTML, the app's own blocks
// (`document`), streaming repair (`options`) with a `streamingCaret`, an extension
// of each kind shown by `renderCustom`, the other render functions
// (`renderCodeBlock`, `renderCodeBlockAction`, `renderTableActions`,
// `renderMath`, `renderImage`), text in the colors HTML or the document
// gives it (`textStyle`), parts styled by `classes` and `styles`
// (the root's text styles passing to every part; a table's grid,
// `tableGrid`, takes its frame), code blocks without
// their scroll indicator (`codeBlockScrollbar`), tables without
// theirs (`tableScrollbar`),
// code blocks' actions (`codeBlockActions`, the built-in copy and one of
// the app's: `onCodeBlockAction`), `selectable`, link presses
// (`onLinkPress`, with the modifier keys held), images' presses
// (`onImagePress`), task boxes' presses (`onTaskPress`),
// and the static functions
// (`TextView.parse`, `TextView.parseHtml`, `TextView.plainText`; emphasis
// beside CJK text read by the CJK-friendly rule, a tag that names no
// element read as text, bare URLs ending at CJK text, escaped brackets
// around reference numbers read as text, links and images left out). Each
// document's texts are its own, so the script finds them. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { TextView } from "nsh/base";

const MARKDOWN = `# Markdown title

Read [the guide](https://example.com/guide) now.

- First item
- Second item

| Name | Size |
|------|-----:|
| Alpha | 12 |

\`\`\`ts
let a = 1;
\`\`\`
`;

const EXTENDED = `Hi @maya!

\`\`\`chart
1 2 3
\`\`\`

<Callout kind="tip">
Inside the callout.
</Callout>

:::note[Heads up]
Inside the note.
:::
`;

const extensions = [
  { name: "mention", pattern: "@(\\w+)" },
  { name: "chart", language: "chart" },
  { name: "callout", tag: "callout" },
  { name: "note", container: "note" },
];

function App() {
  const link = signal("none");
  const action = signal("none");
  const image = signal("none");
  const task = signal("none");
  const parsed = TextView.parse("**a** b");
  const first = parsed.blocks[0];
  // Escaped brackets around reference numbers: text, not a formula.
  const cited = TextView.parse("\\[1\\]\\[3\\]").blocks[0];
  const extended = TextView.parse("Hi @x", { math: false }, [{ name: "m", pattern: "@(\\w+)" }]).blocks[0];
  // Emphasis beside CJK text: strong up to the full-width colon.
  const cjk = TextView.parse("**涨幅：**5%").blocks[0];
  // A bare URL ending where CJK text starts.
  const url = TextView.parse("https://example.com。下一句").blocks[0];
  // A span's color read into a text style.
  const colored = TextView.parseHtml('<p><span style="color: red">x</span></p>').blocks[0];
  // Links and images left out: their text and `alt` text.
  const plain = TextView.parse("[a](https://a.com) ![i](i.png)", { links: false, images: false }).blocks[0];
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <TextView
        markdown={MARKDOWN}
        codeBlockScrollbar={false}
        tableScrollbar={false}
        classes={{ root: "text-[#0000ff]" }}
        styles={{ tableGrid: { backgroundColor: "#00ff00" } }}
        onLinkPress={({ url, modifiers }) => link.set(`${url} (Command: ${modifiers.platform})`)}
        codeBlockActions={[{ id: "copy", label: "Copy code" }, { id: "run", label: "Run code" }]}
        renderCodeBlockAction={(action) => <Text>{`Action ${action.id}`}</Text>}
        onCodeBlockAction={(event) => action.set(`${event.id} ${event.code.language}`)}
        renderTableActions={(table) => <Text>{`Rows: ${table.rows?.length ?? 0}, columns: ${table.head.length}`}</Text>}
      />
      <Text>{`Link: ${link()}`}</Text>
      <Text>{`Code action: ${action()}`}</Text>
      <Text>{`Image pressed: ${image()}`}</Text>
      <TextView
        markdown={"- [x] Draft it\n- [ ] Ship it"}
        onTaskPress={({ index, checked }) => task.set(`${index} ${checked}`)}
      />
      <Text>{`Task: ${task()}`}</Text>
      <TextView html="<h2>From HTML</h2><p>An <b>hypertext</b> paragraph.</p>" />
      <TextView html={'<p>Colors: <span style="color: #e54545">red text</span> and <font color="#00aa00">green text</font></p>'} />
      <TextView
        document={{ blocks: [{ type: "paragraph", content: [{ type: "textStyle", color: "#336699",
          content: [{ type: "text", text: "Document color" }] }] }] }}
        styles={{ textStyle: { fontWeight: "600" } }}
      />
      <TextView document={{ blocks: [{ type: "paragraph", content: [{ type: "text", text: "From a document" }] }] }} />
      <TextView
        markdown="Streaming **stream-bold"
        options={{ streaming: true }}
        streamingCaret={
          <View>
            <Text>CARET</Text>
          </View>
        }
      />
      <TextView
        markdown={EXTENDED}
        extensions={extensions}
        renderCustom={(node) => {
          const attributes = node.attributes ?? {};
          switch (node.name) {
            case "mention":
              return <Text>{`Mention ${attributes["1"]}`}</Text>;
            case "chart":
              return <Text>{`Chart ${node.text}`}</Text>;
            case "callout":
              return <Text>{`Callout ${attributes.kind}`}</Text>;
            default:
              return <Text>{`Note ${attributes.label}`}</Text>;
          }
        }}
      />
      <TextView
        markdown={"```js\nconst b = 2;\n```\n\nEnergy $E=mc^2$ here.\n\n$$\nx^2\n$$\n\n![Logo](https://example.com/logo.png)"}
        renderCodeBlock={(code) => <Text>{`Code ${code.language}: ${code.code}`}</Text>}
        renderMath={(math) => <Text>{`Math ${math.display ? "block" : "inline"}: ${math.tex}`}</Text>}
        renderImage={(image) => <Text>{`Image ${image.alt}: ${image.src}`}</Text>}
        onImagePress={(e) => image.set(e.image.alt ?? "")}
      />
      <TextView
        markdown={"# Classed heading\n\nStyled paragraph."}
        selectable
        classes={{ heading1: "text-[#ff0000]" }}
        styles={{ paragraph: { color: "#00ff00" } }}
      />
      <Text>{`Plain: ${TextView.plainText(parsed)}`}</Text>
      <Text>{`Parsed: ${parsed.blocks.length} ${first.type}`}</Text>
      <Text>{`Cited: ${cited.type}`}</Text>
      <Text>{`Extended: ${extended.type === "paragraph" ? extended.content.map((i) => i.type).join(",") : extended.type}`}</Text>
      <Text>{`CJK emphasis: ${cjk.type === "paragraph" ? cjk.content.map((i) => i.type).join(",") : cjk.type}`}</Text>
      <Text>{`CJK URL: ${url.type === "paragraph" ? url.content.map((i) => (i.type === "link" ? i.url : i.type)).join(",") : url.type}`}</Text>
      <Text>{`Math off: ${TextView.plainText(TextView.parse("Math $x$", { math: false }))}`}</Text>
      <Text>{`Links off: ${plain.type === "paragraph" ? plain.content.map((i) => (i.type === "text" ? i.text : i.type)).join(",") : plain.type}`}</Text>
      <Text>{`From HTML: ${TextView.plainText(TextView.parseHtml("<p>Hi <i>there</i></p>"))}`}</Text>
      <Text>{`Text style: ${colored.type === "paragraph" ? colored.content.map((i) => (i.type === "textStyle" ? `${i.type} ${i.color}` : i.type)).join(",") : colored.type}`}</Text>
      <Text>{`Unknown tag: ${TextView.plainText(TextView.parse("<US tech> up"))}`}</Text>
      <TextView
        document={{ blocks: [{ type: "codeBlock", id: "annotated", code: "Annotated code", wrap: true,
          content: [{ type: "strong", content: [{ type: "text", text: "Annotated code" }] }] }] }}
        codeBlockActions={[{ id: "export", label: "Export annotated" }]}
        onCodeBlockAction={(event) => action.set(`${event.id} ${event.code.id}: ${event.code.code}`)}
      />
    </View>
  );
}

export default App;
