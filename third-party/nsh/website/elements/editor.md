---
title: Editor
description: "The Editor component: a code editor with syntax highlighting, line numbers, several carets, folding, soft wrap, find and replace, diagnostics and decorations, and the keys of code editors."
order: 26.2
group: base
demo: el-editor
---

# Editor

`Editor` is a code editor: syntax highlighting for more than fifty languages, line numbers, several carets, folding,
soft wrap, find and replace, diagnostics and decorations, with the keys of code editors (moving and duplicating lines,
comments, indentation, brackets and quotes that close as they are typed). It holds files of any length: only the rows
in view are made, and highlighting follows each edit line by line, so a long file scrolls and types as a short one
does. Typing goes through the platform's input, so input methods (pinyin, kana, dead keys) and soft keyboards work as
they do in any text field.

The editor owns behavior and comes with a look of its own built from the theme's tokens: the theme's `font-mono` at
13pt in 20pt rows, line numbers in `muted-foreground`, a faint `muted` band behind the lines with a caret, selections
in a tint of `primary`, indent guides in `border`, and the built-in syntax colors that [`TextView`](./text-view.md)'s
code blocks use, in light and dark. Each part takes the app's styles over these defaults (`classes` and `styles`).
Rust makes one with `nsh_base::editor()`, TSX with `<Editor>` from `nsh/base`.

```rust tabs
use nsh_base::editor;
use nsh_core::prelude::*;

const MAIN: &str = "fn main() {\n    println!(\"Hello, world!\");\n}\n";

fn code() -> impl IntoElement {
    let source = signal(SharedString::from(MAIN));
    editor()
        .value(move || Some(source.get()))
        .language("rust")
        .on_change(move |value: &SharedString| source.set(value.clone()))
        .flex_1()
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { Editor } from "nsh/base";

const MAIN = `fn main() {
    println!("Hello, world!");
}
`;

function App() {
  const source = signal(MAIN);
  return <Editor value={source()} onChange={(value) => source.set(value)} language="rust" class="flex-1" />;
}

mount(App);
```

The editor fills the box the app gives it (`flex-1`, a height) and scrolls its text inside: vertically always,
sideways when lines are longer than the box, or not at all with `softWrap`, where long lines wrap at the editor's
width.

## The text

- **Controlled**: pass `value` and set it again in `onChange`, which reports the whole new text. A `value` the app
  changes (a file loaded, a formatter's output) replaces the text as one edit undo takes back, and the carets and
  folds away from what changed stay where they are.
- **Uncontrolled**: pass `defaultValue` and read the text from `onChange` or the ref's `value()`.

Line breaks are `\n`: `\r\n` and `\r` in a text that comes in become `\n`.

## Languages

`language` names the language by its name, an alias, an extension or a file name, in any case: `"rust"`, `"rs"`,
`"typescript"`, `"tsx"`, `"main.go"`, `"Dockerfile"`, `"Makefile"`. It decides the highlighting, the comment that
`mod+/` toggles, the brackets that match and indent, the pairs typing closes, the characters words are made of, and
the default indentation: four spaces, two for web languages (JavaScript, TypeScript, JSON, HTML, CSS, YAML, ...), tabs
for Go and Makefiles. `tabSize` and `hardTabs` set the indentation for every language. Any other name is plain text,
unless the app registered it ([its own languages](#your-own-languages)).

The languages: Rust, JavaScript, JSX, TypeScript, TSX, JSON, Python, Go, C, C++, C#, Java, Kotlin, Swift, Objective-C,
Objective-C++, Ruby, PHP, Lua, Shell, Fish, PowerShell, SQL, HTML, XML, Vue, Svelte, CSS, SCSS, Sass, Less, Markdown,
YAML, TOML, INI, Dockerfile, Makefile, CMake, Dart, Scala, Elixir, Erlang, Haskell, OCaml, F#, Clojure, Zig, Perl, R,
Julia, Nix, Terraform, Protocol Buffers, GraphQL and Diff.

```tsx
<Editor value={source()} onChange={(v) => source.set(v)} language={file().name} tabSize={2} softWrap class="flex-1" />
```

### Your own languages

Rust code teaches an app's editors more languages, and highlights any language with a highlighter of its own (a
tree-sitter grammar, a parser of the app's). `register_language` registers an `EditorLanguage`: its name, aliases,
extensions and file names, and its editing rules (comments, brackets, the pairs typing closes, word characters,
indentation), with `syntax` naming a built-in grammar to highlight it with. `register_highlighter` gives a language,
built-in or registered, the app's highlighter: a type implementing `EditorHighlighter`, which hears every edit (lines,
bytes and positions, as tree-sitter's edits take them) and gives each line's tokens (`EditorToken`, or a tree-sitter
capture or TextMate scope through `EditorToken::from_scope`) within a time budget, off the UI thread. The editor keeps
the tokens, moves them with the text as it is edited and asks again for the lines in view, as it does of the built-in
highlighter. `language` finds the registered languages first, by name, alias, extension or path, in editors and diff
views alike.

Each engine keeps its own languages. A Rust app registers them in its root before it mounts its editors; an app's
crate registers them for the TSX app in the setup of its UI set, which every engine running the app calls first.

```rust
use nsh_base::editor::{EditorLanguage, register_highlighter, register_language};
use nsh_core::prelude::*;

static NIMBLE: EditorLanguage = EditorLanguage::new("Nimble")
    .extensions(&["nb"])
    .line_comment("#")
    .tab_size(2);

#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.setup(|| {
        register_language(&NIMBLE);
        register_highlighter("nimble", || Box::new(NimbleHighlighter::default()));
    });
}
```

```tsx
<Editor value={source()} onChange={(v) => source.set(v)} language="build.nb" class="flex-1" />
```

## Editing

The editor works as code editors do:

- **Several carets.** Alt-click (Option-click) adds a caret, `mod+d` selects the next occurrence of the selection,
  `mod+shift+l` all of them, and the add-caret keys add one on the row above or below. Typing, deleting, moving and
  every command act at each one; Escape goes back to one. `undoSelection` (`cmd+u`, `ctrl+u`) goes back to the
  selections before the last move.
- **Selections grow** by units with `expandSelection` (`ctrl+shift+cmd+right`, `shift+alt+right`): the word, a
  string's contents and the string, a bracket pair's contents and the pair, the line, the text; `shrinkSelection`
  goes back the same way. `splitSelectionIntoLines` (`shift+alt+i`) turns a selection over several lines into one
  selection per line.
- **Indentation.** A new line keeps the line's indentation and adds a level after an opening bracket (Python's `:`,
  Ruby's `do`, ...); Enter between a pair of brackets puts the closing one on its own line. Tab and Shift+Tab indent
  and outdent the selected lines; Backspace in leading spaces goes back to the previous indent stop. `autoIndent` turns
  this off.
- **Brackets and quotes** close as they are typed, wrap a selection, and step over the closing one when it is typed
  again (`autoClose`). The bracket at the caret and its partner are outlined.
- **Undo** takes back whole runs of typing: a word, a deletion, a command. A move or a press starts a new step.
- **Folding.** A line followed by lines indented deeper folds them away with the marker in the gutter: `⌄` to fold,
  `›` and the `⋯` after the line to unfold. A caret that moves into a fold opens it ([Folding](#folding)).
- **Presses.** With a pointer, a click places the caret, a double click selects a word, a triple click a line,
  Shift-click extends the selection and a drag selects by what the click selected. An Alt+Shift drag
  (Option+Shift; Control+Alt on Linux too) selects a block: one selection per row, between the same columns, which
  keep going past the end of short lines. On touch screens a tap places the caret, a double tap or a long press selects
  the word under the finger, and handles at the ends of that selection move each end as a finger drags them (the
  text around them still scrolls).
- **Clipboard.** Copy and cut with no selection take the whole lines of the carets, and those paste back as whole
  lines above the caret's line.

`readOnly` keeps the text as it is while it is still selected, searched and copied.

## Keys

The editor's keys work while it has the focus; other inputs keep theirs. `mod` is Command on macOS and iOS and Control
elsewhere (`keymap`'s keystrokes).

| Keys (macOS) | Keys (Windows, Linux) | Command |
|---|---|---|
| Arrows, with Shift to select | Arrows, with Shift to select | Move by character and row |
| `alt+left` / `alt+right` | `ctrl+left` / `ctrl+right` | Move by word |
| `cmd+left` / `cmd+right`, `home` / `end`, `ctrl+a` / `ctrl+e` | `home` / `end` | The line's first non-blank character (then its start) / the line's end |
| `cmd+up` / `cmd+down` | `ctrl+home` / `ctrl+end` | The start / end of the text |
| `pageup` / `pagedown` | `pageup` / `pagedown` | Up / down a page |
| `alt+backspace` / `alt+delete` | `ctrl+backspace` / `ctrl+delete` | Delete a word left / right |
| `cmd+backspace` / `cmd+delete`, `ctrl+k` | `ctrl+shift+backspace` / `ctrl+shift+delete` | Delete to the line's start / end |
| `cmd+z` / `cmd+shift+z` | `ctrl+z` / `ctrl+shift+z`, `ctrl+y` | Undo / redo |
| `cmd+a` | `ctrl+a` | Select all |
| `cmd+l` | `ctrl+l` | Select the line (again: the next one too) |
| `cmd+d` | `ctrl+d` | Select the next occurrence |
| `cmd+shift+l` | `ctrl+shift+l` | Select every occurrence |
| `cmd+alt+up` / `cmd+alt+down` | `ctrl+alt+up` / `ctrl+alt+down` | Add a caret above / below |
| `escape` | `escape` | Back to one selection |
| `alt+up` / `alt+down` | `alt+up` / `alt+down` | Move the lines up / down |
| `alt+shift+up` / `alt+shift+down` | `alt+shift+up` / `alt+shift+down` | Duplicate the lines up / down |
| `cmd+shift+k` | `ctrl+shift+k` | Delete the lines |
| `cmd+enter` / `cmd+shift+enter` | `ctrl+enter` / `ctrl+shift+enter` | A new line below / above |
| `tab` / `shift+tab`, `cmd+]` / `cmd+[` | `tab` / `shift+tab`, `ctrl+]` / `ctrl+[` | Indent / outdent |
| `cmd+/` | `ctrl+/` | Toggle the line comment |
| `cmd+shift+\` | `ctrl+shift+\` | Go to the matching bracket |
| `ctrl+j` | `ctrl+j` | Join the lines |
| `ctrl+t` | | Swap the characters around the caret |
| `ctrl+alt+left` / `ctrl+alt+right`, with Shift to select | | Move by part of a word (camelCase, snake_case) |
| `shift+alt+a` | `shift+alt+a` | Toggle the block comment |
| `shift+alt+i` | `shift+alt+i` | Split the selection into lines |
| `ctrl+shift+cmd+right` / `ctrl+shift+cmd+left` | `shift+alt+right` / `shift+alt+left` | Expand / shrink the selection |
| `cmd+u` | `ctrl+u` | Back to the previous selections |
| `cmd+g` / `cmd+shift+g`, `f3` / `shift+f3` | `f3` / `shift+f3` | Find the next / previous match |
| `cmd+e` | | Find the selection (`onFindWithSelection`) |
| `cmd+alt+[` / `cmd+alt+]` | `ctrl+shift+[` / `ctrl+shift+]` | Fold / unfold the caret's line |
| `f12` | `f12` | Go to the definition at the caret (`onDefinitionRequest`) |
| `cmd+.` | `ctrl+.` | Code actions at the selection (`onCodeActionRequest`) |
| `cmd+c` / `cmd+x` / `cmd+v` | `ctrl+c` / `ctrl+x` / `ctrl+v` | Copy / cut / paste |

macOS and iOS also have Cocoa's text keys: `ctrl+b` / `ctrl+f` / `ctrl+p` / `ctrl+n` move, `ctrl+h` / `ctrl+d`
delete.

The commands without default keys, and the app's own, take the keys the app binds with
[`keymap`](../modules/nsh.md#keymap), running them through the ref's `run`:

```tsx
import { keymap } from "nsh";

let editor!: EditorRef;

keymap.bind({
  "f9": () => editor.run("sortLinesAscending"),
  "mod+shift+u": () => editor.run("transformToUppercase"),
  "mod+alt+0": () => editor.run("foldAll"),
  "mod+alt+j": () => editor.run("unfoldAll"),
});
```

## Find and replace

`search` is what to find: `{ query, caseSensitive?, wholeWord?, regex?, inSelection? }`. Its matches are highlighted, the one the
selection is on more strongly, and `onSearchChange` reports `{ count, current, error }`: how many matches, which one
the selection is on (from 0), and why a regular expression is not valid. `findNext` and `findPrevious` select the next
and previous match, wrapping around; `replace(text)` replaces the current match and selects the next one, and
`replaceAll(text)` replaces every match as one edit and returns how many. A regular expression's replacement refers to
its groups as `$1` and `${name}`.

`inSelection` finds only inside what was selected when it turned on (the carets' lines when nothing was): the scope
stays while it stays on, through edits, as the selection moves from match to match. `findWithSelection` (`cmd+e` on
macOS) reports the selected text, or the word at the caret, with `onFindWithSelection`, for the find bar to take as
its query.

The find bar is the app's own:

```tsx
import { signal, Text, View } from "nsh";
import { Button, Editor, type EditorRef, type EditorSearchResult, Input } from "nsh/base";

function Find(props: { source: string; onChange: (value: string) => void }) {
  let editor!: EditorRef;
  const query = signal("");
  const replacement = signal("");
  const result = signal<EditorSearchResult>({ count: 0 });
  const status = () =>
    result().error ?? (result().current != null ? `${result().current! + 1} of ${result().count}` : `${result().count} found`);
  return (
    <View class="flex-1">
      <View class="flex-row items-center gap-2 border-b border-border p-2">
        <Input value={query()} onChange={(q) => query.set(q)} onSubmit={() => editor.run("findNext")} placeholder="Find" class="flex-1" />
        <Text class="text-sm text-muted-foreground">{status()}</Text>
        <Button onPress={() => editor.run("findPrevious")} class="px-2"><Text>↑</Text></Button>
        <Button onPress={() => editor.run("findNext")} class="px-2"><Text>↓</Text></Button>
        <Input value={replacement()} onChange={(r) => replacement.set(r)} placeholder="Replace" class="flex-1" />
        <Button onPress={() => editor.replace(replacement())} class="px-2"><Text>Replace</Text></Button>
        <Button onPress={async () => console.log("replaced", await editor.replaceAll(replacement()))} class="px-2"><Text>All</Text></Button>
      </View>
      <Editor
        ref={editor}
        value={props.source}
        onChange={props.onChange}
        language="ts"
        search={query() ? { query: query() } : undefined}
        onSearchChange={(r) => result.set(r)}
        class="flex-1"
      />
    </View>
  );
}
```

## Diagnostics

`diagnostics` marks the problems a language server or a linter reports: a thin wavy underline under each range in its
severity's color (`error`, `warning`, `info`, `hint`). Positions are lines and UTF-16 columns from 0, as a language server's, so
its diagnostics pass through as they come. The marks stay on their text while the user types, until the app passes
new ones; showing the messages (a list, a hover card at the line) is the app's.

A diagnostic carries the rest of a language server's `Diagnostic` too. Its `tags` draw its text as language clients do:
`unnecessary` code (an unused variable, unreachable code) is faded and `deprecated` code struck through, in the
`unnecessaryText` and `deprecatedText` parts; a hint with a tag shows in its text alone. `codeDescription.href` is the
page that describes its code (a lint rule's), and `relatedInformation` lists the other places that tell about it
(`{ location: { uri?, range }, message }`): the hover hands both to the app, which shows them in its hover card and
opens the page. A language server sends tags as numbers (`1`, `2`); the editor takes their names.

```tsx
const problems = signal<EditorDiagnostic[]>([]);

async function lint(text: string) {
  // [{ range, severity, message, source?, code?, codeDescription?, tags?, relatedInformation? }]
  problems.set(await check(text));
}

<Editor
  value={source()}
  onChange={(v) => {
    source.set(v);
    lint(v);
  }}
  language="ts"
  diagnostics={problems()}
  classes={{ diagnosticWarning: "bg-orange-500", unnecessaryText: "text-zinc-400" }}
  class="flex-1"
/>
```

## Decorations

`decorations` style ranges the app chooses: semantic highlighting from a language server, the statement being run, the
lines a review changed. A decoration's `class` and `style` style its text; `lineClass` and `lineStyle` style the rows
of its lines, behind the text. Like diagnostics, they stay on their text through edits until the app sets new ones.

```tsx
const range = (line: number, start: number, end: number) => ({ start: { line, column: start }, end: { line, column: end } });

<Editor
  value={source()}
  language="sql"
  readOnly
  decorations={[
    { range: range(4, 0, 0), lineClass: "bg-green-500/10" },
    { range: range(7, 6, 18), class: "underline text-blue-600" },
  ]}
  class="flex-1"
/>
```

### Your own highlighting

A decoration's `token` colors its text as the built-in highlighting colors that kind of token (`comment`, `keyword`,
`string`, `number`, `title`, `attr`, `built`, `deletion`), in place of what the built-in highlighter found there: the
app's own highlighter (a language server's semantic tokens, a parser of its own) maps its tokens onto these and gets
the editor's colors in light and dark. The innermost decoration's token wins; `class` and `style` apply over it.
`highlighting={false}` turns the built-in highlighter off, so the app's tokens color the text alone, while `language`
still decides comments, brackets and indentation.

```tsx
const kinds: Record<string, EditorToken> = { keyword: "keyword", function: "title", string: "string", type: "built" };

<Editor
  value={source()}
  onChange={(v) => source.set(v)}
  language="ts"
  highlighting={false}
  decorations={semanticTokens().map((t) => ({ range: range(t.line, t.start, t.end), token: kinds[t.type] }))}
  class="flex-1"
/>
```

## Folding

Folds start where lines are indented deeper than the line before them. `foldRanges` gives the editor the app's
own ranges instead (`{ startLine, endLine }`, the shape of a language server's folding ranges, which pass through as
they come): line `startLine` shows the fold and the lines after it through `endLine` fold away. They stay on their
lines through edits until the app passes new ones.

Folds nest: folding a block keeps the folds inside it folded, so unfolding the block shows them as they were.
`foldRecursive` folds a block and every block inside it, `unfoldRecursive` unfolds them all, `foldLevel(n)` folds
every block at nesting level `n`, and `foldSelection` (or `foldRange(range)`) folds any lines, wherever folds start.
`onFoldChange` reports the folded ranges after every change, and `folds()` / `setFolds(ranges)` read and restore
them, to keep them with the file.

```tsx
const ranges = signal<EditorFoldRange[]>([]);
const folded = new Map<string, EditorFoldRange[]>();

<Editor
  ref={editor}
  value={file().text}
  language={file().name}
  foldRanges={ranges()} // from the language server's textDocument/foldingRange
  onFoldChange={(folds) => folded.set(file().name, folds)}
  class="flex-1"
/>
<Button onPress={() => editor.foldLevel(2)}><Text>Fold the methods</Text></Button>
```

## Breakpoints and context menus

A press on a line number reports `onLineNumberPress(line)`, the place for a breakpoint the app draws as a decoration.
The secondary button (a right click, Control-click on a Mac) reports `onContextMenu({ position, x, y })`: the
position in the text under the pointer and the point in the root view, where the app opens its own menu. On touch
screens a long press, a double tap, a handle let go and a tap on the selection report it too, with `selection`: the
selection's box in the root view (`{ x, y, width, height }`), and `x` / `y` at its top middle, for the edit menu.

```tsx
<Editor
  value={source()}
  onContextMenu={({ x, y, selection }) =>
    Menu.popup(selection ? editItems : contextItems, { x, y })
  }
/>
```

```tsx
const breakpoints = signal<number[]>([]);

<Editor
  value={source()}
  language="py"
  onLineNumberPress={(line) =>
    breakpoints.set(breakpoints().includes(line) ? breakpoints().filter((l) => l !== line) : [...breakpoints(), line])
  }
  decorations={breakpoints().map((line) => ({ range: range(line, 0, 0), lineClass: "bg-red-500/15" }))}
  class="flex-1"
/>
```

## Language features

Suggestions, hover information, go to definition and code actions come from the app's language server. The editor
draws the completion list, the inline completion and the definition link itself, with their keys; for the rest it
gives the app the moments and the places, and the app draws its popups (an [`Overlay`](./overlay.md) anchored to a
`pageBounds`).

### Completion

With `completion`, the editor asks the app for suggestions and shows them as a list under the word being typed (above
it near the bottom of the window):

- Typing a letter, digit or `_` at the end of a word asks with `onCompletionRequest(event)`, trigger `"typing"`: `event`
  has its `id`, the caret's `offset` and `position`, the `query` (the word typed so far) and the `queryStart` offset
  where it starts. Each of `completionTriggerCharacters` (`["."]`, `["::", "<"]`) asks with an empty query after it,
  trigger `"character"` (and the `character`), and `showCompletions()` or `run("showCompletions")` asks at the caret,
  trigger `"invoked"`.
- The app answers with `presentCompletions(event.id, items)`. Each item is a language server's `CompletionItem` shape:
  `label`, and optionally `kind` (`"function"`, `"variable"`, `"class"`, ...), `detail`, `documentation`,
  `insertText`, `filterText`, `sortText` and `range`. The answer to the latest request shows; an earlier one, or one
  for a word the caret has left, is set aside.
- Typing on filters the list in place: the query matches each item's `filterText` (else its label) as letters in
  order, in any case, words starting with the query first, then the closest matches, then by `sortText`. The matched
  letters stand out. Pass `incomplete: true` (`presentCompletions(id, items, true)`) for the editor to ask again as
  typing goes on.
- Up and Down (and Control+P / Control+N) move through the list, Page Up and Page Down by a page, Enter and Tab
  accept, Escape closes it. The pointer marks an item and a click (a tap on touch screens) accepts it. The selected
  item's `documentation` shows beside the list.
- Accepting replaces the item's `range` (else the query) with its `insertText` (else its label), as one step undo
  takes back, at the caret and at every other caret with the same text before it, and reports
  `onCompletionAccept({ item })`.
- The list closes as the caret leaves the word, on a space or other punctuation, when the editor loses the focus and
  when the caret scrolls out of view.

A pause in typing (`inlineCompletionDelay`, 300 ms by default) with no list showing asks for an inline completion:
`onInlineCompletionRequest({ id, offset, position })`. `presentInlineCompletion(id, text)` shows `text` at the caret in
a muted color, Tab inserts it, and Escape, an edit or a move clears it.

```tsx
let editor!: EditorRef;

<Editor
  ref={(r) => (editor = r)}
  value={source()}
  onChange={(v) => source.set(v)}
  language="ts"
  completion
  completionTriggerCharacters={["."]}
  onCompletionRequest={async (e) => {
    const items = await server.completion(e.position);
    editor.presentCompletions(e.id, items);
  }}
  onInlineCompletionRequest={async (e) => {
    editor.presentInlineCompletion(e.id, await assistant.suggest(e.offset));
  }}
  class="flex-1"
/>
```

### Hovers and presses

- `onHover(event)`: the mouse rests over a character (desktops and the web). `event` has its `position`, its UTF-16
  `offset`, the `range` of its word, the pointer's `pagePosition`, the word's `pageBounds`, the `modifiers` held and
  the `diagnostics` there, whose messages the app shows. Moving to another word reports the next hover at once.
- `onHoverEnd()`: the mouse left the word or the editor, or the text changed or scrolled under it.
- `onTextPress(event)`: a character was pressed, after the editor placed its caret: `{ position, offset, range,
  pagePosition, modifiers, clicks }`.
- `caretBounds()` and `rangeBounds(range)`: where the caret and a range are, `{ bounds, pageBounds }` (in the editor
  and in the root view): a popup of the app's opens there.

```tsx
const hover = signal<EditorHoverEvent | null>(null);

<Editor
  ref={editor}
  value={source()}
  language="ts"
  onHover={(event) => hover.set(event)}
  onHoverEnd={() => hover.set(null)}
  class="flex-1"
/>
<If when={hover()}>
  {(event) => (
    <Overlay anchor={event().pageBounds} placement="top" class="rounded-md border border-border bg-popover p-2">
      <Text>{event().diagnostics.map((d) => d.message).join("\n") || describe(event().range)}</Text>
    </Overlay>
  )}
</If>
```

### Go to definition and code actions

Holding Mod (Command on macOS and iOS, Control elsewhere) turns the words under the mouse into links, as in code
editors:

- With Mod held over a word (pressed while the mouse rests there, or the mouse moved there with it held), the editor
  asks with `onDefinitionRequest(event)`, trigger `"hover"`: `event` has its `id`, the character's `position` and
  `offset`, and the word's `range`. Answer with `presentDefinitionLink(event.id, range)` when the language server
  finds a definition: the range is underlined (the `definitionLink` part) and the pointer becomes a hand over it. The
  link goes when Mod is released, the mouse leaves it or the text changes or scrolls, or with `hideDefinitionLink()`.
  The answer to the latest request shows; an earlier one is set aside.
- A Mod-click on a word asks with trigger `"press"`; on the link the caret stays where it is. F12 (`goToDefinition`,
  `run("goToDefinition")`) asks for the word at the caret, trigger `"key"`. The app goes to the definition:
  `revealPosition` and `setSelections` for one in the same text, its own navigation for another file.
- Mod+. (`showCodeActions`, `run("showCodeActions")`) reports `onCodeActionRequest({ range, position, bounds })`: the
  primary selection (start first), the caret and its box. The app asks its language server for actions, shows its
  menu at `bounds.pageBounds` (a [`Menu`](./menu.md) or an `Overlay`), and applies the chosen one's edits with
  `edit(edits)`.

```tsx
let editor!: EditorRef;

<Editor
  ref={(r) => (editor = r)}
  value={source()}
  onChange={(v) => source.set(v)}
  language="ts"
  onDefinitionRequest={async (e) => {
    const target = await server.definition(e.position);
    if (!target) return;
    if (e.trigger === "hover") editor.presentDefinitionLink(e.id, target.originRange ?? e.range);
    else editor.revealPosition(target.range.start, true);
  }}
  onCodeActionRequest={async (e) => {
    const actions = await server.codeActions(e.range);
    const picked = await choose(actions, e.bounds?.pageBounds);
    if (picked) editor.edit(picked.edits);
  }}
  class="flex-1"
/>
```

## Size and scrolling

With `minRows` and / or `maxRows` the editor grows with its text: it is as tall as its rows, at least `minRows`
of them, and from `maxRows` on its text scrolls, as a message box or a cell of a notebook does. Otherwise the
app sizes it, and `scrollBeyondLastLine` lets the text scroll on past its last line: up to a screen (`true`, the
default), not at all (`false`) or a number of rows. As the caret moves, `cursorSurroundingLines` rows stay in view
around it. Dragging a selection past the editor's edges scrolls on, faster the farther out the pointer goes.

`showWhitespaces` shows a `·` for each space and a `→` for each tab (the `whitespace` part), and `rulers` draws a
line at each of its columns (the `ruler` part), as guides of a line's length.

```tsx
<Editor
  defaultValue={message()}
  language="markdown"
  minRows={2}
  maxRows={8}
  rulers={[72]}
  showWhitespaces
/>
```

## Methods

`ref={editor}` gives the editor's methods (`EditorRef`), for the app's buttons, menus and keys. Methods that return a
value (`value()`, `selections()`, `replaceAll()`, `canUndo()`, `caretBounds()`, `folds()`, ...) return a `Promise` of it in JS, so `await`
them: `const text = await editor.value()`.

| Method | Description |
|---|---|
| `focus()`, `blur()` | Takes the focus, or gives it up. |
| `value()` | `Promise<string>`: the text. |
| `setValue(value)` | Replaces the text, as an edit undo takes back. |
| `insert(text)` | Types `text` at each selection, as it is (brackets do not close). |
| `edit(edits)` | Applies `{ range, text }` replacements (ranges of the current text; one overlapping an earlier one is skipped) as one step undo takes back; the selections move with the text around them. Code actions and formatting edits go here. |
| `selections()` | `Promise<EditorSelection[]>`: every selection, `{ anchor, head }`, the primary (newest) last. |
| `setSelections(selections)` | Sets the selections (the last one primary) and scrolls the primary one into view. |
| `run(command)` | Runs a command, as its keys would ([Commands](#commands)). |
| `replace(text)` | Replaces the current match and selects the next. |
| `replaceAll(text)` | `Promise<number>`: replaces every match as one edit; how many. |
| `fold(line)`, `unfold(line)` | Folds the lines under line `line` (from 0), or unfolds it. |
| `foldRecursive(line)`, `unfoldRecursive(line)` | Folds the fold on line `line` and every fold inside it, or unfolds them all. |
| `foldLevel(level)` | Folds every fold at nesting level `level` (1: the outermost). |
| `foldRange(range)` | Folds the lines of `range` (`{ startLine, endLine }`), wherever folds start. |
| `folds()` | `Promise<EditorFoldRange[]>`: the folded ranges, nested ones included. |
| `setFolds(folds)` | Folds exactly `folds`. |
| `scrollToLine(line)` | Scrolls line `line` into view, unfolding what hides it. |
| `canUndo()`, `canRedo()` | `Promise<boolean>`: whether there is an edit to take back, or to do again. |
| `caretBounds()` | `Promise<EditorBounds \| null>`: the primary caret's box, `{ bounds, pageBounds }`, in the editor (its scrolling applied) and in the root view; `null` before the editor is laid out. |
| `rangeBounds(range)` | `Promise<EditorBounds[]>`: the boxes of `range`, one per row it covers. |
| `scrollOffset()`, `setScrollOffset(offset)` | `Promise<Point>`: how far the text is scrolled; scrolls it to `{ x, y }`. |
| `visibleRange()` | `Promise<EditorRange>`: the text the viewport shows, from its first row's start to its last row's end. |
| `selectedText()` | `Promise<string>`: the primary selection's text. |
| `offsetToPosition(offset)`, `positionToOffset(position)` | `Promise<EditorPosition>`, `Promise<number>`: between UTF-16 offsets of `value()` and positions. |
| `revealPosition(position, center)` | Scrolls `position` into view, unfolding what hides it; to the middle with `center`. |
| `goToLine(line)` | Puts the caret at line `line`'s start (from 0) and scrolls it to the middle. |
| `showCompletions()` | Asks for completions at the caret, the word before it the query ([Completion](#completion)). |
| `presentCompletions(id, items, incomplete?)` | Answers completion request `id`: the list shows `items`, filtered by what has been typed since; with `incomplete`, typing on asks again. No items close the list. |
| `hideCompletions()` | Closes the completion list. |
| `presentInlineCompletion(id, text)`, `hideInlineCompletion()` | Answers inline completion request `id` with `text`, shown at the caret; clears it. |
| `presentDefinitionLink(id, range)`, `hideDefinitionLink()` | Answers definition request `id` (trigger `"hover"`): `range` is underlined as a link ([Go to definition](#go-to-definition-and-code-actions)); hides it. |

```tsx
let editor!: EditorRef;

<Button onPress={() => editor.run("toggleComment")}><Text>Comment</Text></Button>
<Button onPress={async () => save(await editor.value())}><Text>Save</Text></Button>
<Button onPress={async () => (await editor.canUndo()) && editor.run("undo")}><Text>Undo</Text></Button>
<Button onPress={() => editor.setSelections([{ anchor: { line: 0, column: 0 }, head: { line: 0, column: 0 } }])}>
  <Text>Go to the top</Text>
</Button>
<Editor ref={editor} value={source()} onChange={(v) => source.set(v)} language="rs" class="flex-1" />
```

### Commands

`run` takes the editor's commands by name (`EditorCommand`):

| Commands | What they do |
|---|---|
| `moveLeft`, `moveRight`, `moveUp`, `moveDown`, `moveWordLeft`, `moveWordRight`, `moveLineStart`, `moveLineEnd`, `movePageUp`, `movePageDown`, `moveDocumentStart`, `moveDocumentEnd` | Move the carets. |
| `selectLeft`, `selectRight`, `selectUp`, `selectDown`, `selectWordLeft`, `selectWordRight`, `selectLineStart`, `selectLineEnd`, `selectPageUp`, `selectPageDown`, `selectDocumentStart`, `selectDocumentEnd` | Extend the selections. |
| `moveToMatchingBracket` | To the bracket matching the one at the caret. |
| `selectAll`, `selectLine`, `selectWord`, `selectNextOccurrence`, `selectPreviousOccurrence`, `selectAllOccurrences` | Select. |
| `moveSubwordLeft`, `moveSubwordRight`, `selectSubwordLeft`, `selectSubwordRight` | Move or extend by part of a word (camelCase humps, snake_case parts). |
| `moveParagraphUp`, `moveParagraphDown`, `selectParagraphUp`, `selectParagraphDown` | Move or extend to the blank line before or after the paragraph. |
| `expandSelection`, `shrinkSelection` | Grow the selections by a unit, or back. |
| `undoSelection`, `redoSelection` | Back to the selections before the last move, or forward again. |
| `splitSelectionIntoLines` | One selection per line of each selection. |
| `addCaretAbove`, `addCaretBelow`, `singleSelection` | Add a caret; back to one selection. |
| `deleteBackward`, `deleteForward`, `deleteWordLeft`, `deleteWordRight`, `deleteToLineStart`, `deleteToLineEnd`, `deleteLine` | Delete. |
| `newline`, `newlineBelow`, `newlineAbove`, `indent`, `outdent`, `toggleComment`, `toggleBlockComment` | Lines, indentation and comments. |
| `sortLinesAscending`, `sortLinesDescending` | Sort the selected lines (every line with only a caret). |
| `transformToUppercase`, `transformToLowercase`, `transformToTitleCase` | Change the case of the selections (a caret: its word). |
| `trimTrailingWhitespace` | Remove the whitespace at the end of every line. |
| `moveLinesUp`, `moveLinesDown`, `duplicateLinesUp`, `duplicateLinesDown`, `joinLines`, `transposeCharacters` | Rearrange. |
| `undo`, `redo` | Undo and redo. |
| `fold`, `unfold`, `foldAll`, `unfoldAll` | Fold at the caret's line, or everything. |
| `foldRecursive`, `unfoldRecursive` | Fold the caret's fold and every fold inside it, or unfold them. |
| `foldSelection` | Fold the lines of each selection that spans several. |
| `findNext`, `findPrevious` | Select the next or previous match of `search`. |
| `findWithSelection` | Report the selected text for the find bar (`onFindWithSelection`). |
| `copy`, `cut`, `paste` | The clipboard. |
| `showCompletions` | Ask for completions at the caret ([Completion](#completion)). |
| `goToDefinition` | Ask for the definition of the word at the caret (`onDefinitionRequest`, trigger `"key"`). |
| `showCodeActions` | Ask for the code actions at the selection (`onCodeActionRequest`). |

## Styling the parts

`class` and `style` style the editor's box. `classes` takes Tailwind classes by part and `styles` inline styles by
part; a part's classes come after its own default styles, so they win, and its `styles` win over its classes. The font
is set with `fontFamily`, `fontSize` and `lineHeight`, which the editor measures its text in.

```tsx
<Editor
  value={source()}
  onChange={(v) => source.set(v)}
  language="tsx"
  fontFamily="JetBrains Mono"
  fontSize={14}
  lineHeight={22}
  class="flex-1 rounded-lg border border-border"
  classes={{
    gutter: "bg-muted",
    lineNumber: "text-xs",
    activeLine: "bg-yellow-500/10",
    selection: "bg-blue-500/30",
  }}
  styles={{ caret: { backgroundColor: "#f59e0b", width: 3 } }}
/>
```

| Part | What it is | Default |
|---|---|---|
| `gutter` | The column of line numbers and fold markers | 12pt before the numbers, 4pt after the markers |
| `lineNumber` | Every line number | Right-aligned, `muted-foreground` |
| `activeLineNumber` | The numbers of the lines with a caret, after `lineNumber` | `foreground` |
| `foldMarker` | The marker of a line where a fold starts | `⌄`, `›` folded, `muted-foreground` |
| `content` | The text area beside the gutter | 4pt before the text |
| `line` | Every row of text | |
| `activeLine` | Behind the rows of the lines with a caret, below the scroll indicators | `muted`, faint |
| `selection` | Behind selected text | A tint of `primary` |
| `caret` | The carets | 2pt wide, `foreground`, blinking |
| `composition` | The text an input method is composing | Underlined |
| `searchMatch` | The matches of `search` | Translucent amber |
| `currentSearchMatch` | The match the selection is on, after `searchMatch` | Stronger amber |
| `matchingBracket` | The bracket at the caret and its partner | A 1pt border |
| `indentGuide` | A guide per indentation level | A 1pt line of `border` |
| `foldPlaceholder` | What a folded line shows after its text | ` ⋯ `, `muted-foreground` |
| `placeholder` | Shown while the text is empty | `muted-foreground` |
| `diagnosticError` | The line under an error | `destructive` |
| `diagnosticWarning` | The line under a warning | Amber |
| `diagnosticInfo` | The line under an information | Blue |
| `diagnosticHint` | The line under a hint | `muted-foreground` |
| `unnecessaryText` | The text of an `unnecessary` diagnostic | `muted-foreground` |
| `deprecatedText` | The text of a `deprecated` diagnostic | Struck through |
| `whitespace` | The marks of spaces and tabs (`showWhitespaces`) | `·` and `→`, `muted-foreground` at 60 % |
| `ruler` | The lines of `rulers` | A 1 point line of `border` |
| `selectionHandle` | The knobs of the handles at the ends of a touch selection | A 10pt dot of `primary` |
| `selectionHandleStart`, `selectionHandleEnd` | The start's knob (above its line) and the end's (below), after `selectionHandle` | |
| `completionMenu` | The completion list's box | `popover`, a 1pt `border`, rounded, a shadow |
| `completionItem` | Every item of the list | A row's height, 8pt of padding |
| `selectedCompletionItem` | The selected item, after `completionItem` | `accent` |
| `completionMatch` | The letters of a label the query matched | Semibold, `primary` |
| `completionDetail` | An item's detail, after its label | Right-aligned, `muted-foreground` |
| `completionKind` | An item's kind, before its label | A short name (`fn`, `var`, `cls`), `muted-foreground` |
| `completionDocumentation` | The selected item's documentation, beside the list | As `completionMenu`, at most 320pt wide |
| `inlineCompletion` | The inline completion at the caret | `muted-foreground` |
| `definitionLink` | The underline of the definition link | A 1pt line of `primary` under the text |

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | | The text, controlled by the app (set it again from `onChange`). |
| `defaultValue` | `.default_value(..)` | `string` | | The first text, when the editor keeps its own. |
| `language` | `.language(..)` | `string` | plain text | A language's name, alias, extension or file name ([Languages](#languages)). |
| `placeholder` | `.placeholder(..)` | `string` | | Shown while the text is empty. |
| `readOnly` | `.read_only(..)` | `boolean` | `false` | The text is selected and copied, not changed. |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | Takes the focus when it appears. |
| `lineNumbers` | `.line_numbers(..)` | `boolean` | `true` | The gutter's line numbers. |
| `softWrap` | `.soft_wrap(..)` | `boolean` | `false` | Long lines wrap at the editor's width. |
| `tabSize` | `.tab_size(..)` | `number` | the language's | The columns of a tab and of an indentation level. |
| `hardTabs` | `.hard_tabs(..)` | `boolean` | the language's | Indents with tabs. |
| `folding` | `.folding(..)` | `boolean` | `true` | Indented lines fold with the gutter's markers. |
| `foldRanges` | `.fold_ranges(..)` | `EditorFoldRange[]` | by indentation | Where folds start, the app's ([Folding](#folding)). |
| `highlighting` | `.highlighting(..)` | `boolean` | `true` | The built-in syntax highlighting ([Your own highlighting](#your-own-highlighting)). |
| `autoClose` | `.auto_close(..)` | `boolean` | `true` | Brackets and quotes close as they are typed. |
| `autoIndent` | `.auto_indent(..)` | `boolean` | `true` | A new line keeps the indentation and indents after an opening bracket. |
| `activeLine` | `.active_line(..)` | `boolean` | `true` | The rows of the lines with a caret are highlighted. |
| `indentGuides` | `.indent_guides(..)` | `boolean` | `true` | The guides of indentation. |
| `scrollBeyondLastLine` | `.scroll_beyond_last_line(..)` | `boolean \| number` | `true` | The text scrolls on past its last line: up to a screen (`true`), not at all (`false`) or that many rows. |
| `fontFamily` | `.font_family(..)` | `string` | the theme's `font-mono` | The font the text is drawn and measured in. |
| `fontSize` | `.font_size(..)` | `number` | `13` | The font size, in points. |
| `lineHeight` | `.line_height(..)` | `number` | `20` | The height of a row, in points. |
| `search` | `.search(..)` | `EditorSearch` | | What to find ([Find and replace](#find-and-replace)). |
| `diagnostics` | `.diagnostics(..)` | `EditorDiagnostic[]` | `[]` | Problems to mark ([Diagnostics](#diagnostics)). |
| `decorations` | `.decorations(..)` | `EditorDecoration[]` | `[]` | Ranges the app styles ([Decorations](#decorations)). |
| `classes` | `.classes(..)` | `EditorClasses` | `{}` | Tailwind classes by part. |
| `styles` | `.styles(..)` | `EditorStyles` | `{}` | Inline styles by part, over the classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | | What screen readers call the editor. |
| `showWhitespaces` | `.show_whitespaces(..)` | `boolean` | `false` | Spaces and tabs show as `·` and `→`. |
| `rulers` | `.rulers(..)` | `number[]` | `[]` | Columns to draw a vertical line at. |
| `minRows` | `.min_rows(..)` | `number` | | The editor grows with its text from this many rows ([Size and scrolling](#size-and-scrolling)). |
| `maxRows` | `.max_rows(..)` | `number` | | The editor grows with its text up to this many rows, then scrolls. |
| `cursorSurroundingLines` | `.cursor_surrounding_lines(..)` | `number` | `1` | The rows kept in view above and below the caret. |
| `completion` | `.completion(..)` | `boolean` | `false` | The editor asks for suggestions and shows them as a list ([Completion](#completion)). |
| `completionTriggerCharacters` | `.completion_trigger_characters(..)` | `string[]` | `[]` | What else asks for completions as it is typed. |
| `inlineCompletionDelay` | `.inline_completion_delay(..)` | `number` | `300` | Milliseconds typing pauses before an inline completion is asked for. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | | The editor's box. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value: &SharedString\| ..)` | The text changed: the whole new text. |
| `onSelectionChange` | `.on_selection_change(\|selections: &Vec<EditorSelection>\| ..)` | The selections changed: every one, the primary last. |
| `onFocus`, `onBlur` | `.on_focus(\|\| ..)`, `.on_blur(\|\| ..)` | The editor took or lost the focus. |
| `onSearchChange` | `.on_search_change(\|result: &EditorSearchResult\| ..)` | The search's matches changed: `{ count, current, error }`. |
| `onLineNumberPress` | `.on_line_number_press(\|line: &u32\| ..)` | A line number was pressed: the line, from 0. |
| `onContextMenu` | `.on_context_menu(\|event: &EditorContextMenuEvent\| ..)` | The secondary button was pressed over the text, or a touch selected text: `{ position, x, y, selection? }`. |
| `onHover` | `.on_hover(\|event: &EditorHoverEvent\| ..)` | The mouse rests over a character ([Language features](#language-features)). |
| `onHoverEnd` | `.on_hover_end(\|\| ..)` | The hover ended. |
| `onTextPress` | `.on_text_press(\|event: &EditorTextPressEvent\| ..)` | A character was pressed: with its word, the modifiers and the clicks. |
| `onFindWithSelection` | `.on_find_with_selection(\|query: &String\| ..)` | `findWithSelection` ran: the text for the find bar's query. |
| `onFoldChange` | `.on_fold_change(\|folds: &Vec<EditorFoldRange>\| ..)` | The folded ranges changed: every one, nested ones included. |
| `onCompletionRequest` | `.on_completion_request(\|event: &EditorCompletionRequest\| ..)` | The editor asks for completions: `{ id, offset, position, query, queryStart, trigger, character? }` ([Completion](#completion)). |
| `onCompletionAccept` | `.on_completion_accept(\|event: &EditorCompletionAcceptEvent\| ..)` | An item was accepted and inserted: `{ item }`. |
| `onInlineCompletionRequest` | `.on_inline_completion_request(\|event: &EditorInlineCompletionRequest\| ..)` | Typing paused: `{ id, offset, position }`, for an inline completion. |
| `onDefinitionRequest` | `.on_definition_request(\|event: &EditorDefinitionRequest\| ..)` | The editor asks for a definition: `{ id, position, offset, range, trigger }` ([Go to definition](#go-to-definition-and-code-actions)). |
| `onCodeActionRequest` | `.on_code_action_request(\|event: &EditorCodeActionRequest\| ..)` | The user asked for code actions: `{ range, position, bounds? }`. |

## Accessibility

Screen readers call the editor by its `accessibilityLabel`; its focus is a text input's, so the platform's text
services (input methods, dictation, soft keyboards) work in it.

## Related

- [TextView](./text-view.md): documents of Markdown and HTML, whose code blocks share the editor's syntax colors.
- [DiffView](./diff-view.md): the changes between two texts, in the editor's syntax colors.
- [Input](./input.md): single and multiline text fields with the platform's own editing.
- [`keymap`](../modules/nsh.md#keymap): the app's keys for the editor's commands.
- [`nsh/base`](../modules/nsh-base.md): the other base components.
