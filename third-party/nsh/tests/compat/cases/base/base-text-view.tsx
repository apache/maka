// A case of the API's test suite (docs/dev/compatibility.md): `TextView`
// of `nsh/base`, a document shown with texts and views: Markdown (a
// heading, a link, a list, a table, code), HTML, the app's own blocks
// (`document`), streaming repair (`options`) with a `streamingCaret`, an extension
// of each kind shown by `renderCustom`, the other render functions
// (`renderCodeBlock`, `renderCodeBlockAction`, `renderTableActions`,
// `renderMath`, `renderImage`), parts styled by `classes` and `styles`
// (the root's text styles passing to every part), code blocks without
// their scroll indicator (`codeBlockScrollbar`), tables without
// theirs (`tableScrollbar`),
// code blocks' actions (`codeBlockActions`, the built-in copy and one of
// the app's: `onCodeBlockAction`), `selectable`, link presses (`onLinkPress`),
// images' presses (`onImagePress`), and the static functions
// (`TextView.parse`, `TextView.parseHtml`, `TextView.plainText`). Each
// document's texts are its own, so the script finds them. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { Button, TextView } from "nsh/base";

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
  const parsed = TextView.parse("**a** b");
  const first = parsed.blocks[0];
  const extended = TextView.parse("Hi @x", { math: false }, [{ name: "m", pattern: "@(\\w+)" }]).blocks[0];
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <TextView
        markdown={MARKDOWN}
        codeBlockScrollbar={false}
        tableScrollbar={false}
        classes={{ root: "text-[#0000ff]" }}
        onLinkPress={({ url }) => link.set(url)}
        codeBlockActions={[{ id: "copy", label: "Copy code" }, { id: "run", label: "Run code" }]}
        renderCodeBlockAction={(action) => <Text>{`Action ${action.id}`}</Text>}
        onCodeBlockAction={(event) => action.set(`${event.id} ${event.code.language}`)}
        renderTableActions={(table) => <Text>{`Rows: ${table.rows?.length ?? 0}, columns: ${table.head.length}`}</Text>}
      />
      <Text>{`Link: ${link()}`}</Text>
      <Text>{`Code action: ${action()}`}</Text>
      <Text>{`Image pressed: ${image()}`}</Text>
      <TextView html="<h2>From HTML</h2><p>An <b>hypertext</b> paragraph.</p>" />
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
        renderImage={({ image: selected }) => (
          <Button accessibilityLabel={selected.alt} onPress={() => image.set(selected.alt ?? "")}>
            <Text>{`Image ${selected.alt}: ${selected.src}`}</Text>
          </Button>
        )}
      />
      <TextView
        document={{ blocks: [{ type: "paragraph", content: [{ type: "image", src: "https://example.com/default.png", alt: "Default logo", width: 24, height: 24 }] }] }}
        onImagePress={(pressed) => image.set(pressed.alt ?? "")}
      />
      <TextView
        markdown={"# Classed heading\n\nStyled paragraph."}
        selectable
        classes={{ heading1: "text-[#ff0000]" }}
        styles={{ paragraph: { color: "#00ff00" } }}
      />
      <Text>{`Plain: ${TextView.plainText(parsed)}`}</Text>
      <Text>{`Parsed: ${parsed.blocks.length} ${first.type}`}</Text>
      <Text>{`Extended: ${extended.type === "paragraph" ? extended.content.map((i) => i.type).join(",") : extended.type}`}</Text>
      <Text>{`Math off: ${TextView.plainText(TextView.parse("Math $x$", { math: false }))}`}</Text>
      <Text>{`From HTML: ${TextView.plainText(TextView.parseHtml("<p>Hi <i>there</i></p>"))}`}</Text>
    </View>
  );
}

export default App;
