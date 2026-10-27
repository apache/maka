---
title: RichEditor
description: "The rich text editor of nsh/base: documents defined by the app's schema, commands, plugins, history, keymaps, input rules and Markdown, after ProseMirror's architecture, with its state in Rust."
order: 26.25
group: base
demo: el-rich-editor
---

# RichEditor

`RichEditor` is a rich text editor built after ProseMirror's architecture. The app defines what a document is made
of with a schema (paragraphs, headings, lists, mentions, whatever node and mark types it needs), and the editor keeps
every document valid against it. Changes are steps grouped into transactions, so they undo, map positions and travel
as JSON; behavior comes from plugins (history, keymaps, input rules, Markdown shortcuts, the app's own); commands are
values a toolbar runs and asks about. The editor's state, its commands and its plugins run in Rust: typing, key
bindings and input rules never wait for JS, and the app reads the state as JSON when it asks for it.

An editor has two parts: the session (`createRichEditor`), which owns the state and which the app's code drives, and
the view (`<RichEditor editor={…} />`), which renders the session natively and turns the platform's input into
transactions. Several views can show one session.

The editor's kernel is a Rust port of [ProseMirror](https://prosemirror.net) by Marijn Haverbeke, and its extension
layer follows [Tiptap](https://tiptap.dev): their data structures, commands and names carry over, and so does what
you know of them. Both are MIT-licensed, and their licenses apply to what is ported from them.

```tsx
import { mount } from "nsh";
import { RichEditor, createRichEditor, history, inputRules, keymap, markdown, markdownRules, starterKeymap, baseKeymap, toggleMark } from "nsh/base";

const editor = createRichEditor({
  content: "# Notes\n\nStart typing…",
  format: "markdown",
  plugins: [
    history(),
    keymap({ "Mod-b": toggleMark("bold"), "Mod-i": toggleMark("italic") }),
    starterKeymap(),
    baseKeymap(),
    inputRules(markdownRules()),
    markdown(),
  ],
});

function App() {
  return <RichEditor editor={editor} class="flex-1" />;
}

mount(App);
```

Without `schema` an editor uses the starter schema (`starterSchema()`); without `plugins` it gets the starter kit
(`starterKit()`: the starter's input rules and key bindings, the base key bindings and the history). An empty
`plugins` array makes an editor with no plugins at all.

## Styling

The editor draws the document with the app's look: `classes` and `styles` style its parts (`root`, `content`, `caret`,
`selection`, `placeholder`, `composition`, `selectedNode`, `listMarker`), its nodes by type (`nodes: { heading:
"text-2xl font-bold", "heading[level=2]": "text-xl" }`) and its marks (`marks: { bold: "font-bold" }`). The items of
lists whose node spec sets `extra.listMarker` to `"bullet"` or `"ordered"` (the starter schema's lists) show a marker
in the `listMarker` part: `•`, `◦`, `▪` by depth, or numbers from the list's `start`, placed before the item, in the list's indent (`pl-6` on the list, as a browser indents `ul`).

```tsx
<RichEditor
  editor={editor}
  classes={{
    nodes: { heading: "text-2xl font-bold", bulletList: "pl-6", codeBlock: "font-mono bg-muted p-3 rounded-md" },
    marks: { bold: "font-bold", italic: "italic", code: "font-mono bg-muted" },
    listMarker: "text-muted-foreground",
  }}
/>
```

The `content` part is the box of the document inside the editor's scroll view: its padding (`content: "px-6 py-5"`)
is the room around the text, and the scroll bar runs along the editor's own edge. A drag that selects past the top
or bottom of the editor scrolls the document along, faster the further the pointer goes.

### Bubble menu

`bubbleMenu` is Tiptap's bubble menu: the app's content shown next to the selection, above it by default
(`bubbleMenuPlacement`, flipping to the other side where there is no room) at `bubbleMenuOffset` points (8), in an
overlay that follows the text as it scrolls. The app passes it while it wants it shown, from the session's state:

```tsx
const inLink = () => (revision(), editor.isActive("link"));

<RichEditor
  editor={editor}
  bubbleMenu={inLink() ? <LinkMenu href={editor.getAttributes("link").href} /> : undefined}
  bubbleMenuPlacement="bottom"
/>
```

A link menu edits the link under the caret with `chain([extendMarkRange("link"), command("setLink", { href })])`
and removes it with `command("unsetLink")` after the same `extendMarkRange`.

## Schemas

`defineSchema(spec)` reads a schema in ProseMirror's shape and throws with what is wrong in it. Node types name their
`content` (a content expression: `"inline*"`, `"paragraph+"`, `"(heading | paragraph) block*"`), their `group`,
whether they are `inline` or an `atom`, the `marks` they allow and their `attrs` with defaults and validation
(`"string"`, `"number"`, `"boolean"`). The first block type is the default one: what Enter creates and what fills
required content. Keys a spec does not know are kept as the type's extra data, for frameworks built on the editor.

```tsx
import { createRichEditor, defineSchema } from "nsh/base";

const schema = defineSchema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    mention: { group: "inline", inline: true, atom: true, attrs: { id: {}, label: { default: "" } } },
    text: { group: "inline" },
  },
  marks: { bold: {}, link: { attrs: { href: {} }, inclusive: false } },
});

const editor = createRichEditor({ schema, doc: schema.parse("Hello") });
```

A `RichSchema` reads and writes documents: `parse(content, format?)` (plain text by default, `"markdown"`, or JSON),
`parseMarkdown(markdown)`, `serialize(doc, format?)` (Markdown by default, `"text"`, `"json"`) and `check(doc)`, which
returns the document with its attribute defaults filled in. `nodes`, `marks` and `topNode` name its types. Markdown
maps to the starter schema's names (`paragraph`, `heading`, `blockquote`, `codeBlock`, `bulletList`,
`orderedList`, `listItem`, `bold`, `italic`, `code`, `link`, `strike`).

## Commands

A command is a value: `toggleMark("bold")` makes an object the app keeps, binds to keys and passes to the editor.
`editor.run(command)` runs it and returns whether it applied; `editor.can(command)` asks without changing anything,
which is how a toolbar enables its buttons. `editor.isActive(name, attrs?)` tells whether a mark or a node is active
at the selection (`isActive("heading", { level: 2 })`).

| Command | What it does |
| --- | --- |
| `toggleMark(name, attrs?)` | Adds the mark to the selection, or removes it where present; at a cursor, for the text typed next |
| `setMark(name, attrs?)` / `unsetMark(name)` | Adds or removes a mark |
| `setBlockType(name, attrs?)` | Makes the selected textblocks of a type (`setBlockType("heading", { level: 2 })`) |
| `wrapIn(name, attrs?)` / `lift()` | Wraps the selected blocks in a node (a quote) / lifts them out of their parent |
| `wrapInList(name, attrs?)` | Wraps the selected blocks in a list |
| `splitListItem(name)` / `sinkListItem(name)` / `liftListItem(name)` | Splits, indents or outdents list items |
| `undo()` / `redo()` | Undoes or redoes a change (with `history()`) |
| `selectAll()`, `setTextSelection(anchor, head?)`, `setNodeSelection(pos)` | Selects |
| `insertText(text)`, `insertContent(content, format?)` | Inserts text or content over the selection |
| `setNodeAttribute(pos, attr, value)` | Sets an attribute of the node at a position, as one undoable change |
| `command(name)` | A command without parameters by name: `"splitBlock"`, `"joinBackward"`, `"exitCode"`, `"newlineInCode"`, `"selectParentNode"`, … |
| `chain(commands)` | Runs commands one after another as one transaction (one undo step); applies only when every one does |
| `first(commands)` | Runs the first command that applies |

```tsx
editor.run(chain([setBlockType("heading", { level: 1 }), toggleMark("bold")]));
const canIndent = editor.can(sinkListItem("listItem"));
```

## The session

| Member | What it is |
| --- | --- |
| `state`, `doc`, `selection` | The state, the document and the selection as JSON, made when read |
| `revision` | How many transactions the state has applied |
| `isEmpty`, `undoDepth`, `redoDepth`, `composing` | What a UI shows about the editor |
| `setContent(content, format?)` | Replaces the document, as one undoable change |
| `insertContent(content, format?)` | Inserts content over the selection |
| `getJSON()`, `getMarkdown()`, `getText()`, `textBetween(from?, to?, separator?)` | The document in a format |
| `dispatch(tr)` | Applies a transaction given as JSON (its steps against the current document) |
| `subscribe(listener)` / `unsubscribe(id)` | Hears every change, from any source, with the new revision |
| `focus()`, `blur()` | Moves the keyboard focus to or from the views showing the editor |

Positions count as ProseMirror's do: a text counts its UTF-16 code units, a leaf node one, a node with content its
two boundaries. Anything that must outlive edits keeps an id in a node's attributes or a mark.

### Taking over transactions

`editor.dispatchTransaction = (tr) => { … }` makes the app commit every transaction itself: the handler gets each
one as JSON and commits it with `editor.applyTransaction(tr)`, or drops it. Collaboration, logging and transactions
that must pass the app's checks use it; `null` hands committing back to the editor. The handler hears typing in JS's
next turn, and the document changes when it commits.

## Extensions

Extensions are Tiptap's: each one brings, together, its node or mark type, its key bindings, input and paste rules,
plugins and named commands, and an editor made from extensions gets its schema, keymap, rules and command table from
them. The built-in ones are classes named as Tiptap's, used as they are or configured:

```tsx
import { RichEditor, StarterKit, Underline, command, createRichEditor } from "nsh/base";

const editor = createRichEditor({
  extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false })],
  content: "Hello",
  editable: true,
});

editor.run(command("toggleHeading", { level: 2 }));
editor.run(command("toggleBold"));
```

`StarterKit` brings `Document`, `Paragraph`, the text node, `Heading`, `Blockquote`, `BulletList`, `OrderedList`,
`ListItem`, `TaskList`, `TaskItem`, `CodeBlock`, `HardBreak`, `HorizontalRule`, `RichImage` (Tiptap's `Image`),
`Bold`, `Italic`, `Strike`, `Code`, `Underline`, `Link`, `Highlight`, `Subscript`, `Superscript`, `RichTextStyle` (Tiptap's `TextStyle`),
`TextAlign`, `History`, `TrailingNode`, `Typography` and `ListKeymap`. An option named as one set to `false` leaves
it out, an object configures it (`heading: { levels }`, `history: { depth }`, `textAlign: { types }`,
`codeBlock: { enableTabIndentation }`). Each class's `configure(options)` and `extend({...})` make a
`RichExtension`, which has `name`, `type`, `priority` and `options`. Every editor also gets the core keymap (Enter,
Backspace, Delete, select all).

Each extension adds Tiptap's commands, which `command(name, args)` runs: `toggleBold`, `setItalic`,
`unsetStrike`, `toggleHeading({ level })`, `setParagraph`, `toggleBlockquote`, `toggleBulletList`,
`toggleOrderedList`, `toggleTaskList`, `toggleCodeBlock({ language })`, `setHardBreak`, `setHorizontalRule`,
`setImage({ src })`, `toggleHighlight({ color })`, `setTextAlign("center")`, `unsetTextAlign`, and the link,
character count and suggestion commands below.

The list toggles work on whole lists, as a word processor's list buttons do: `toggleOrderedList` in a bulleted list
numbers it at every level, nested lists included, and a list's own toggle takes the selected blocks out of every
list around them.

The order of `extensions` is their priority among equals: an extension listed later binds its keys before the ones
before it; `priority` (100 by default) ranks them otherwise. With `extensions`, an editor's `plugins` come after the
extensions' plugins.

### The app's extensions

`defineExtension` makes one. Its functions run once, when an editor is made with it, with the extension's options,
and return data: commands, rules and plugins as the factories above make them.

```tsx
import { StarterKit, command, createRichEditor, defineExtension, insertText, textRule } from "nsh/base";

const Signature = defineExtension({
  name: "signature",
  priority: 200,
  addOptions: () => ({ text: "— Sent from NSH" }),
  addCommands: (options) => ({ insertSignature: insertText(options.text) }),
  addKeyboardShortcuts: () => ({ "Mod-Alt-s": command("insertSignature") }),
  addInputRules: () => [textRule("\\(sig\\)$", "✍")],
});

const editor = createRichEditor({ extensions: [StarterKit, Signature.configure({ text: "Best, Ana" })] });
```

`node` or `mark` (in `defineSchema`'s form) makes it a node or mark extension; `addGlobalAttributes` adds attributes
to other types; `addProseMirrorPlugins` returns plugins, `RichEditorPlugin`s included; `addPasteRules` returns
`textRule` and `markRule` rules for pasted text. A built-in class's `extend({...})` replaces the parts it gives:
`Underline.extend({ addKeyboardShortcuts: () => ({ "Mod-Alt-u": toggleMark("underline") }) })`.

An app's crate registers extensions written in Rust through its UI set, and JS takes them by name:

```rust
use nsh_base::rich_editor::extensions::{Extension, RichExtensionRegistry};

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.rich_extension("mention", || Extension::new("mention") /* .add_plugins(...) */);
}
```

```tsx
const editor = createRichEditor({ extensions: [StarterKit, richExtension("mention", { char: "@" })] });
```

`richExtension(name, options)` also finds every built-in extension by its name (`"text"`, `"bold"`, ...).

## Plugins

| Factory | What it adds |
| --- | --- |
| `history({ depth?, newGroupDelay? })` | Undo history; changes within `newGroupDelay` milliseconds (500) undo together |
| `keymap(bindings)` | Commands by key name: `"Mod-b"` (Cmd on Apple platforms, Ctrl elsewhere), `"Shift-Enter"`, `"Alt-ArrowUp"` |
| `baseKeymap()` | Enter, Backspace, Delete, select all and the platform's text editing keys |
| `starterKeymap()` | The starter schema's bindings: marks, headings, lists, code blocks, hard breaks |
| `inputRules(rules)` | Text typed before the cursor that matches a rule turns into what the rule makes; Backspace right after undoes it |
| `markdown(options?)` | Markdown as you type, Markdown paste and Markdown copy (`blockRules`, `inlineRules`, `paste`, `copyAsMarkdown`) |
| `starterKit()` | The starter's input rules and bindings, the base bindings and the history |

A plugin's place in the list is its priority: keymaps and input rules earlier in the list handle a key or a text
first. Input rules come from `markdownRules()` (headings, quotes, lists, code fences, rules, the common marks),
`typographyRules()` (smart quotes, ellipsis, em dash), `textRule(match, replacement)`, `markRule(match, mark)`,
`wrappingRule(match, node)` and `textblockRule(match, node)`. A rule's `match` is a regular expression ending in `$`,
matched against the text before the cursor.

### The app's plugins

`new RichEditorPlugin(key)` makes a plugin whose behavior is the app's, set with chained calls:

```tsx
import { RichEditorPlugin, createRichEditor, starterKit } from "nsh/base";

const suggestions = new RichEditorPlugin("suggestions")
  .captureKeys(["ArrowUp", "ArrowDown", "Enter", "Escape"], (key) => moveSuggestion(key))
  .filterTransaction((tr) => tr.meta?.locked !== true)
  .appendTransaction((trs, state) => null);

const editor = createRichEditor({ plugins: [starterKit(), suggestions] });

// While the suggestion list is open, its keys are the list's.
suggestions.capturing = true;
editor.setDecorations("suggestions", [{ from: 5, to: 9, kind: "inline", attrs: { class: "bg-accent" } }]);
```

- `captureKeys(keys, handler)`: while `capturing` is true the editor consumes these keys and tells `handler` which
  one was pressed, right after; the keyboard stays as quick as with no plugin.
- `editor.setDecorations(key, decorations)`: inline attributes, node attributes and widgets the view draws over the
  document without changing it. They follow every change until set again.
- `filterTransaction(hook)` and `appendTransaction(hook)` see the transactions the app's own calls make (`run`,
  `dispatch`, `setContent`, …) in that call: `filterTransaction` may drop one, `appendTransaction` may return one
  more to apply with it. `subscribe` hears every change, typing included.

## Links, character counts and suggestions

Three plugins carry Tiptap's Link, CharacterCount and Suggestion behavior, all of it native:

```tsx
import { RichEditor, characterCount, createRichEditor, insertMention, link, starterKit, starterSchema, suggestion, withMention } from "nsh/base";

const editor = createRichEditor({
  schema: withMention(starterSchema()),
  plugins: [
    starterKit(),
    link({ defaultProtocol: "https" }),
    characterCount({ limit: 280 }),
    suggestion({ key: "mention", char: "@", decorationClass: "text-primary", captureKeys: ["ArrowUp", "ArrowDown", "Enter"] }),
  ],
});

editor.on("transaction", () => {
  const s = editor.suggestion("mention");
  if (s?.active) showPeople(s.query, editor.coordsAtPos(s.range.from), s.lastKey);
  setCount(`${editor.characters()} / ${editor.characterLimit}`);
});

// The list picked someone:
editor.run(insertMention(editor.suggestion("mention")!.range, "u1", "Joan"));
```

- `link(options?)`: a URL typed before a space or Enter becomes a link, as do the URLs in pasted text (`autolink`);
  a URL pasted over a selection links the selection (`linkOnPaste`); a press on a link with Mod held, or while the
  editor is read-only, opens it through the app's URL handling (`openOnClick`); `enableClickSelection` selects the
  whole link on a press. URLs are found with or without a protocol (`nsh.dev`, `https://nsh.dev/docs`, e-mail
  addresses), and the protocol a bare host gets is `defaultProtocol` (`http`). Links take the protocols `http`,
  `https`, `ftp`, `ftps`, `mailto`, `tel`, `callto`, `sms`, `cid`, `xmpp` and those in `protocols`, so
  `setLink({ href })`, `toggleLink(attrs?)` and autolinking keep scripts (`javascript:`) and data URLs out.
  `unsetLink()` removes the link around the selection.
- `characterCount(options?)`: `editor.characters(mode?)` counts the text's characters (`"textSize"`, UTF-16 units as
  JS's `length`) or the document's positions (`"nodeSize"`); `editor.words()` counts its words (Unicode word
  boundaries). With `limit`, changes that would go past it are refused and pasted content is trimmed to what fits;
  a first document over the limit is trimmed (`autoTrim`). `setCharacterLimit(limit)` changes the limit and
  `editor.characterLimit` reads it.
- `suggestion(options?)`: follows a trigger (`char`, `@` by default) typed before the cursor. `allowSpaces` lets the
  query hold spaces, `allowedPrefixes` lists what may precede the trigger (a space by default; `anyPrefix` takes
  anything), `startOfLine` asks for it at the line's start (a `/` command menu). `editor.suggestion(key)` gives
  `{ active, range, query, text, lastKey, keyCount }`; the active range carries the app's `decorationClass` (and
  `decorationEmptyClass` while the query is empty). While a suggestion is active the keys in `captureKeys` belong
  to the app's list: the editor takes them and records the last one in the state, and Escape dismisses the
  suggestion (`exitSuggestion(key)` does too). `replaceSuggestion(content, key?)` replaces the trigger and the query
  with text or JSON content.
- `withMention(schema, { name?, char? })` adds Tiptap's mention node: an inline atom with `id`, `label` and its
  trigger, written as `@label` in text and as `<span data-type="mention">` in HTML. `insertMention(range, id, label?)`
  replaces a suggestion's range with a mention and a space.

The popup is the app's: it reads the suggestion's state, places itself at `coordsAtPos(range.from)` and draws the
items its own way.
