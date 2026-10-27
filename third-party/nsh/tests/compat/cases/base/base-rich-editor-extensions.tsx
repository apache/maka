// A case of the API's test suite (docs/dev/compatibility.md): the rich text
// editor's Link, CharacterCount and Suggestion plugins of `nsh/base`
// without a view: `link`, `characterCount`, `suggestion` and `withMention`,
// their commands (`setLink`, `toggleLink`, `unsetLink`,
// `setCharacterLimit`, `replaceSuggestion`, `exitSuggestion`,
// `insertMention`) and the session's queries (`suggestion`, `characters`,
// `words`, `characterLimit`). Each line shows one result; its script
// checks each.
import { Text, View, signal } from "nsh";
import {
  characterCount,
  createRichEditor,
  exitSuggestion,
  insertMention,
  insertText,
  link,
  replaceSuggestion,
  setCharacterLimit,
  setLink,
  setTextSelection,
  starterSchema,
  suggestion,
  toggleLink,
  unsetLink,
  withMention,
} from "nsh/base";

function App() {
  const lines = signal<string[]>([]);

  const run = () => {
    const out: string[] = [];
    const step = (name: string, f: () => string) => {
      try {
        out.push(`${name}: ${f()}`);
      } catch (e) {
        out.push(`${name}: threw ${(e as Error).message}`);
      }
    };

    const links = createRichEditor({
      content: "visit",
      plugins: [link({ autolink: true, linkOnPaste: true, openOnClick: true, enableClickSelection: false, protocols: ["web+app"], defaultProtocol: "https" })],
    });
    step("Autolink", () => {
      links.run(setTextSelection(6));
      links.run(insertText(" nsh.dev"));
      links.run(insertText(" "));
      links.run(setTextSelection(9));
      return `${links.isActive("link")} ${links.getAttributes("link").href}`;
    });
    step("SetLink", () => {
      links.run(setTextSelection(1, 6));
      const refused = links.run(setLink({ href: "javascript:alert(1)" }));
      const set = links.run(setLink({ href: "https://a.io" }));
      return `${refused} ${set} ${links.isActive("link")}`;
    });
    step("UnsetLink", () => `${links.run(unsetLink())} ${links.isActive("link")}`);
    step("ToggleLink", () => `${links.run(toggleLink({ href: "web+app:x" }))} ${links.isActive("link")}`);

    const counted = createRichEditor({ content: "Hello world", plugins: [characterCount({ limit: 12, mode: "textSize", autoTrim: true })] });
    step("Count", () => `${counted.characters()} ${counted.words()} ${counted.characterLimit} ${counted.characters("nodeSize")}`);
    step("Limit", () => {
      counted.run(setTextSelection(12));
      const one = counted.run(insertText("!"));
      counted.run(insertText("?"));
      return `${one} ${counted.getText()}`;
    });
    step("SetLimit", () => {
      counted.run(setCharacterLimit(null));
      counted.run(insertText("?"));
      return `${counted.characterLimit} ${counted.getText()}`;
    });

    const schema = withMention(starterSchema(), { name: "mention", char: "@" });
    const mentions = createRichEditor({
      schema,
      content: "Hi",
      plugins: [
        suggestion({ key: "mention", char: "@", allowSpaces: false, allowToIncludeChar: false, allowedPrefixes: [" "], anyPrefix: false, startOfLine: false, decorationClass: "text-primary", decorationEmptyClass: "opacity-50", captureKeys: ["ArrowDown", "Enter"] }),
        suggestion({ key: "slash", char: "/", startOfLine: true }),
      ],
    });
    step("Schema", () => `${schema.nodes.includes("mention")}`);
    step("Suggest", () => {
      mentions.run(setTextSelection(3));
      mentions.run(insertText(" @jo"));
      const s = mentions.suggestion("mention");
      return `${s.active} ${s.query} ${s.text} ${s.range.from}-${s.range.to} ${mentions.suggestion("slash").active}`;
    });
    step("Mention", () => {
      const range = mentions.suggestion("mention").range;
      mentions.run(insertMention(range, "u1", "Joan"));
      return `${mentions.getText().trim()} ${mentions.suggestion("mention").active}`;
    });
    step("Replace", () => {
      mentions.run(insertText("@ab"));
      const replaced = mentions.run(replaceSuggestion("done", "mention"));
      return `${replaced} ${mentions.getText().trim()}`;
    });
    step("Exit", () => {
      mentions.run(insertText(" @x"));
      const exited = mentions.run(exitSuggestion("mention"));
      return `${exited} ${mentions.suggestion("mention").active} ${mentions.suggestion() === null}`;
    });
    lines.set(out);
  };

  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <View onPress={run}><Text>RunExtensions</Text></View>
      {() => lines().map((line) => <Text>{line}</Text>)}
    </View>
  );
}

export default App;
