// Initial RichEditor reconciliation of a long Markdown document: per section a
// heading, three paragraphs, a five-item list, a code block, a pipe table and a
// quote (about 34 source lines, 8 top-level blocks). Change `LINES` to compare
// sizes: the first commit grows linearly with it.
import { mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { createRichEditor, RichEditor, StarterKit, TableKit } from "nsh/base";

const LINES = 5000;
const WORDS = "alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega".split(" ");
const words = (seed: number, n: number) =>
  Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(" ");

function largeDoc(lines: number): string {
  const out: string[] = ["# Long document", ""];
  let s = 0;
  while (out.length < lines) {
    s++;
    out.push(`## Section ${s}: ${words(s, 4)}`, "");
    for (let p = 0; p < 3; p++) {
      out.push(
        `${words(s * 31 + p, 38)}. See **${words(s + p, 2)}** and \`code_${p}\`, then [a link](https://example.com/${s}).`,
        "",
      );
    }
    for (let i = 0; i < 5; i++) out.push(`- ${words(s * 13 + i, 9)}`);
    out.push("", "```rust");
    for (let i = 0; i < 8; i++) out.push(`    let v_${i} = f(${i * s});`);
    out.push("```", "", "| Key | Value | Note |", "| --- | --- | --- |");
    for (let i = 0; i < 4; i++) out.push(`| ${words(s * 23 + i, 1)} | ${i * s} | ${words(s * 29 + i, 4)} |`);
    out.push("", `> ${words(s * 37, 16)}.`, "");
  }
  return out.join("\n") + "\n";
}

const content = largeDoc(LINES);

function App() {
  const editor = createRichEditor({ extensions: [StarterKit, TableKit], content, format: "markdown" });
  return (
    <View style={{ flex: 1 }}>
      <RichEditor editor={editor} style={{ flex: 1 }} />
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
