---
title: RichEditor
description: "The rich text editor of nsh/base: documents defined by the app's schema, commands, plugins, history, keymaps, input rules and Markdown, after ProseMirror's architecture, with its state in Rust."
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
import { Window } from "nsh/desktop";

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

mount(() => (
  <Window id="main">
    <App />
  </Window>
));
```

Without `schema` an editor uses the starter schema (`starterSchema()`); without `plugins` it gets the starter kit
(`starterKit()`: the starter's input rules and key bindings, the base key bindings and the history). An empty
`plugins` array makes an editor with no plugins at all.

`onCompositionChange({ composing })` reports `true` when this view starts input-method composition and `false`
when it ends, including cancellation. Updates to the text being composed keep the current state. The callback
observes the session's updated `composing` value and any committed text, so an app can retain the editor view
while composition is active and release it when it ends. Starting or canceling composition can keep the document
and its revision unchanged; `onChange` reports document edits.

`onReadonlyInput()` fires when someone types into an editor that cannot be edited (`editable={false}`,
the editor's `editable: false` / `setEditable(false)`, or a plugin's `editable`), which stays out of the document: a hardware keyboard's characters, a software keyboard's
typing and an input method's commit, once per change. An app can use it to offer editing, as a
reading view that turns to editing when someone starts typing. Text the app inserts itself, deleting and pasting are not reported. A keyboard that replaces a word it typed
(autocorrect, a picked suggestion) fires again, so treat it as a sign of typing, not a character count.

```tsx
<RichEditor editor={editor} editable={false} onReadonlyInput={() => showEditHint()} />
```

## Styling

The editor draws the document with the app's look: `classes` and `styles` style its parts (`root`, `content`, `caret`,
`selection`, `placeholder`, `composition`, `selectedNode`, `listMarker`, the touch selection's handles
`selectionHandle`, `selectionHandleStart`, `selectionHandleEnd`, and for tables `selectedCell`,
`tableGrip`, `tableResizeHandle`, `tableDropIndicator`), its nodes by type (`nodes: { heading:
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

### Sizing

An editor is sized as a block with `height: auto`: without a height it is as tall as its document laid out at its
width, plus its padding, and it grows and shrinks with each edit. `maxHeight` (`max-h-*`) stops it there, and the
document scrolls inside it from then on, keeping the caret in view, as a multiline `Input` does; `minHeight`
(`min-h-*`) keeps it at least that tall. A height or flex sizing (`h-*`, `flex-1`) gives it a fixed box that the
document scrolls in. A chat composer is an editor with a `maxHeight` and no height:

```tsx
<RichEditor editor={editor} class="max-h-40 px-3 py-2" />
```

`onContentSizeChange={({ contentSize }) => …}` reports the laid-out document's size when it changes, as
`Input`'s does, at most once per frame. `contentSize` is its full flow size in points, including blocks outside
the viewport and excluding the `content` part's padding. It stays independent of a fixed viewport height.
Scrolling does not report a change; use `onScroll` for the offset.

### Touch selection

On iOS and Android the editor selects as the platform's own text views do. A long press selects the word under the
finger, and moving the finger after it extends the selection by whole words; a long press on blank space places the
caret. A double tap selects a word, a triple tap the paragraph. The selection a touch made has a handle at each end
(`selectionHandle`, a dot in the theme's `primary`), which the finger drags to move that end. When the finger lifts,
the system's edit menu opens over the selection with Cut, Copy, Paste and Select All; a tap on the selection opens it
again, and a tap on the caret opens Paste and Select All. The menu offers only what applies: Select All is left out
once everything is selected, and a read-only editor offers Copy and Select All. Each action is a transaction of the editor, so the
toolbar's `isActive` follows the selection, `toggleMark` formats it, and undo takes a cut or a paste back. Taps,
keys, input methods and the mouse select as before.

### A bar over the keyboard

`inputAccessoryViewID` (Rust `.input_accessory(id)`) shows the
[`InputAccessoryView`](../docs/forms-and-keyboard.md#a-bar-over-the-keyboard-ios-inputaccessoryview) with that
`nativeID` on top of the keyboard while the editor has the focus, as an `Input`'s `ios={{ inputAccessoryViewID }}`
does: it comes and goes with the keyboard and moves with it natively. Formatting buttons there run on the session and
leave the focus in the editor:

```tsx
import { Text, View } from "nsh";
import { Button, RichEditor, command } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

<RichEditor editor={editor} inputAccessoryViewID="format" />
<InputAccessoryView nativeID="format">
  <View style={{ flexDirection: "row", padding: 8, gap: 8 }}>
    <Button onPress={() => editor.run(command("toggleBold"))}>
      <Text>Bold</Text>
    </Button>
    <Button onPress={() => editor.blur()}>
      <Text>Done</Text>
    </Button>
  </View>
</InputAccessoryView>
```

Input accessories are iOS's; elsewhere the editor shows none.

### Bubble menu

`bubbleMenu` is Tiptap's bubble menu: the app's content shown next to the selection, above it by default
(`bubbleMenuPlacement`, flipping to the other side where there is no room) at `bubbleMenuOffset` points (8), in an
overlay that follows the text as it scrolls. The app passes it while it wants it shown, from the session's state:

```tsx
const revision = signal(editor.revision);
editor.on("revision", ({ revision: r }) => revision.set(r));
const inLink = () => (revision(), editor.isActive("link"));

<RichEditor
  editor={editor}
  bubbleMenu={inLink() ? <LinkMenu href={editor.getAttributes("link").href} /> : undefined}
  bubbleMenuPlacement="bottom"
/>
```

A link menu edits the link under the caret with `chain([extendMarkRange("link"), command("setLink", { href })])`
and removes it with `command("unsetLink")` after the same `extendMarkRange`.

`contentLayer` is the app's own layer over the document, inside the box that scrolls: what it holds moves with
the text in the same frame. Place its children in the content box's points, where `editor.nodeRect(pos)` (the box
of the block starting at `pos`) and `editor.coordsAtPos(pos)` answer: a handle in a block's margin, a marker beside
a node. The layer itself takes no press; its children do.

```tsx
const box = editor.nodeRect(blockStart);

<RichEditor
  editor={editor}
  contentLayer={box ? <Handle style={{ position: "absolute", left: box.x - 28, top: box.y }} /> : undefined}
/>
```

### Copy and paste

A copy or cut puts the selection on the clipboard in two forms at once, as ProseMirror does: as plain text (Markdown with the
`markdown` extension's `copyAsMarkdown`) and as HTML written by the schema's `renderHTML`, which mail, documents and
other editors paste with its formatting. The HTML marks the copied slice (`data-pm-slice`), so a paste into a
`RichEditor` gets the same nodes back, mentions and other inline nodes included, a part of a list item stays a part of
one, and spaces are kept. Pasted HTML from elsewhere is read by the schema's parse rules. A Rust plugin changes what
is copied with `transform_copied`.

### Pasted and dropped files

Files reach the app, which decides what they become (an image node, an attachment, a link to an uploaded copy); the
editor inserts nothing for them and keeps its selection, where the app inserts what it makes of them. A paste of
images or of files copied in a file manager calls `onPasteFiles` with `{ files, uris }`: `files` the images with
their bytes, `uris` the copied files' `file:` URLs. On the desktops, files dragged from another application onto
the editor call its `onFileDrop` with `{ uris, mimeTypes }`, as a [view's file drops](./view.md#desktop-file-drops)
do, and `onFileDragEnter` / `onFileDragLeave` follow the drag, for a hint such as "Release to attach". Without
`onFileDrop` the editor leaves dropped files to the view around it that listens.

Text dragged onto the editor from another app or another view goes in where it is let go: the caret moves there and
the text goes in as a paste of it would (with its HTML when the drag has some, through `transformPasted` and
`handlePaste`), as one undo step. iOS delivers text drops; the desktops and Android leave text drags to the platform.

```tsx
<RichEditor
  editor={editor}
  onPasteFiles={({ files }) => attach(files)}
  onFileDrop={({ uris, mimeTypes }) => attachFiles(uris, mimeTypes)}
/>
```

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

A `RichSchema` reads and writes documents: `parse(content, format?)` (plain text by default, `"markdown"`, `"html"`, or JSON),
`parseMarkdown(markdown)`, `serialize(doc, format?)` (Markdown by default, `"text"`, `"html"`, `"json"`) and `check(doc)`, which
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
| `pasteHTML(html)`, `pasteText(text)` | Pastes HTML or plain text over the selection as a paste of it would go in; whether it pasted |
| `getJSON()`, `getHTML()`, `getMarkdown()`, `getText()`, `textBetween(from?, to?, separator?)` | The document in a format |
| `dispatch(tr)` | Applies a transaction given as JSON (its steps against the current document) |
| `on(event, listener)` | Calls `listener` with the payload of every `event`, in JS's next turn: `revision` (`{ revision }`, after every change, from any source), `update`, `selectionUpdate`, `transaction`, `focus`, `blur`, `delete`. Returns a function that stops it; a listener added while a component renders stops with the component |
| `focus()`, `blur()` | Moves the keyboard focus to or from the views showing the editor |

When `insertContent` receives text, Markdown or JSON, the content opens at its edges and fits where it goes: at a
caret in text, one paragraph joins the text around it, while lists, tables and other blocks that cannot fit inline
remain blocks. An HTML string follows Tiptap's `insertContent`: bare text or inline markup joins the text, and
explicit block elements insert as blocks.

Positions count as ProseMirror's do: a text counts its UTF-16 code units, a leaf node one, a node with content its
two boundaries. Anything that must outlive edits keeps an id in a node's attributes or a mark. A position query
(`resolve(pos)`, `nodeAt(pos)`, `coordsAtPos(pos)`, `findParentNode(name, pos)`, ...) throws a `RangeError` for a
position outside the document (`0` to `doc.content.size`), as ProseMirror's `resolve` does, and answers `null` where
nothing is there (`nodeAt` at the end of a node, `coordsAtPos` with no view showing the editor). `run` and `can` throw
a `TypeError` for a command, node or mark type the editor does not know.

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
`ListItem`, `TaskList`, `TaskItem`, `CodeBlock`, `CodeBlockHighlight`, `HardBreak`, `HorizontalRule`, `RichImage` (Tiptap's `Image`),
`Bold`, `Italic`, `Strike`, `Code`, `Underline`, `RichLink` (Tiptap's `Link`), `Highlight`, `Subscript`, `Superscript`, `RichTextStyle` (Tiptap's `TextStyle`),
`TextAlign`, `History`, `TrailingNode`, `Typography` and `ListKeymap`. An option named as one set to `false` leaves
it out, an object configures it (`heading: { levels }`, `history: { depth }`, `textAlign: { types }`,
`codeBlock: { enableTabIndentation }`). Each class's `configure(options)` and `extend({...})` make a
`RichExtension`, which has `name`, `type`, `priority` and `options`. Every editor also gets the core keymap (Enter,
Backspace, Delete, select all).

Code blocks that name a language (` ```rust `, `toggleCodeBlock({ language: "rust" })`) are colored as `TextView`
colors fenced code, with the same syntaxes and palette: that is `CodeBlockHighlight`, which plays the part of Tiptap's
`CodeBlockLowlight` without a highlighter to pass in. `StarterKit.configure({ codeBlockHighlight: false })` leaves
code plain. Typing in a long block does not wait for the colors: they are worked out off the engine thread and arrive
a moment later. On the web the syntaxes come from the page once, the first time a block needs them, shared with
`TextView`; they are not in the first download. Without the platform's feature `highlight` code stays plain.

In Rust it is `kit::code_block_highlight()`, part of `kit::starter_kit()` and of `starter::plugins`.

Each extension adds Tiptap's commands, which `command(name, args)` runs: `toggleBold`, `setItalic`,
`unsetStrike`, `toggleHeading({ level })`, `setParagraph`, `toggleBlockquote`, `toggleBulletList`,
`toggleOrderedList`, `toggleTaskList`, `toggleCodeBlock({ language })`, `setHardBreak`, `setHorizontalRule`,
`setImage({ src })`, `toggleHighlight({ color })`, `setTextAlign("center")`, `unsetTextAlign`, and the link,
character count and suggestion commands below. An image's `src` is what `Image` takes (a URL, a file path or
`file:` URL, a `data:` URI); without `width` and `height` it shows at its natural size, and with one of them at that
side and its aspect ratio.

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

### Node views

`addNodeView` returns the component that renders every node of the extension's node type: a stock tag in the text, a
card between paragraphs, a mention, an embed. The node type must be an atom (`atom: true`, or a leaf): an arrow key
that reaches it selects it as a node and the next one moves past it, as in ProseMirror and Tiptap (a node with
`selectable: false`, such as a mention, is stepped over as one character), and Backspace deletes it. A node with
content is refused.

```tsx
import { RichEditor, StarterKit, createRichEditor, defineExtension, type RichNodeViewProps } from "nsh/base";

function StockTag(props: RichNodeViewProps) {
  return (
    <View class={props.selected ? "rounded border border-primary px-1" : "rounded border border-transparent px-1"}>
      <Text>{`$${props.node.attrs.symbol}`}</Text>
    </View>
  );
}

const Stock = defineExtension({
  name: "stock",
  node: { group: "inline", inline: true, atom: true, attrs: { symbol: { default: "AAPL" } } },
  addNodeView: () => StockTag,
});

const editor = createRichEditor({ extensions: [StarterKit, Stock] });
```

The component runs once per node. Its props follow the node: read in JSX or an effect, `node` (`{ type, attrs,
textContent }`) and `selected` change in place when the node's attributes or its selection change, and typing around
the node never calls it. `editor` is the editor the node is in, `extension` is `{ name, options }`. `getPos()` is
where the node starts now (`null` once it is gone); `updateAttributes(attrs)` sets some of its attributes and
`deleteNode()` deletes it, each one undoable change through the editor (and its `dispatchTransaction`).

A press on a view's own area selects its node and gives the editor the focus, inline views as block ones (ProseMirror
selects a clicked atom too); with Shift held it extends the selection instead, and with Mod held it does what it does
on text. A control inside the view (a `Button`, a `Link`) keeps its press, and the selection stays where it was.

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
  more to apply with it. `on("revision", …)` hears every change, typing included.

#### Paste

A plugin can take part in a paste with ProseMirror's `transformPasted` and `handlePaste`:

```tsx
const paste = new RichEditorPlugin("paste")
  .transformPasted((slice) => slice)
  // Word's list items, Google Docs' bold, a video link pasted on its own: the app reads the clipboard itself.
  .handlePaste((slice, clipboard) => {
    if (!isVideoLink(clipboard.text)) return false;
    editor.run(insertContent({ type: "video", attrs: { src: clipboard.text } }));
    return true;
  });
```

- `transformPasted(slice)` changes the content before it goes in, each plugin's in turn. The content is a
  `RichSliceJSON` (`{ content, openStart, openEnd }`), parsed from the clipboard's HTML by the schema's rules, else
  from its text.
- `handlePaste(slice, clipboard)` returning `true` means the app handled the paste and the editor inserts nothing.
  `clipboard` is `{ text, html }`, what the clipboard held: an app that reads Word or Google Docs HTML, Markdown or a
  link in its own way inserts the result itself (`editor.run(insertContent(...))`) and returns `true`.

An app that cleans up the clipboard's HTML itself (Word's lists, Google Docs' wrapper, Markdown turned into HTML)
hands the result on with `editor.pasteHTML(html)` and returns `true`; plain text goes on with `editor.pasteText(text)`.
They are ProseMirror's `pasteHTML` and `pasteText`: the content is read as a paste is, by the schema's parse rules and
fitted to the selection, so a node marked `isolating` (a figure with its caption) stays whole where JSON or Markdown
given to `insertContent` opens even through such a node at the content's edges. The editor's own paste steps (links,
character limits, paste rules) apply. The plugins' `transformPasted` and `handlePaste` are not asked again. They
return whether something was pasted.

```tsx
const paste = new RichEditorPlugin("paste").handlePaste((_slice, clipboard) => {
  const docs = /^<b id="docs-internal-guid-[^"]*">([\s\S]*)<\/b>$/.exec(clipboard.html);
  return docs ? editor.pasteHTML(docs[1]) : false;
});
```

Paste is the one input that waits for JS: once a plugin has a paste hook, the paste goes in after the hooks have
answered, a JS turn later. Pastes go in in the order they were made. A paste whose document or selection changes
while its hooks answer starts over from the editor as it is then. Typing and keys never wait. To insert something
that takes longer, such as an upload, `handlePaste` returns `true` and the app inserts it when it is ready.

## Links, character counts and suggestions

Three plugins carry Tiptap's Link, CharacterCount and Suggestion behavior, all of it native:

```tsx
import { RichEditor, characterCount, createRichEditor, insertMention, link, setSuggestionOpen, starterKit, starterSchema, suggestion, withMention } from "nsh/base";

const editor = createRichEditor({
  schema: withMention(starterSchema()),
  plugins: [
    suggestion({ key: "mention", char: "@", decorationClass: "text-primary", captureKeys: ["ArrowUp", "ArrowDown", "Enter"] }),
    starterKit(),
    link({ defaultProtocol: "https" }),
    characterCount({ limit: 280 }),
  ],
});

editor.on("transaction", () => {
  const s = editor.suggestion("mention");
  if (s?.active) {
    const people = peopleMatching(s.query);
    editor.run(setSuggestionOpen(people.length > 0, "mention"));
    showPeople(people, editor.coordsAtPos(s.range.from), s.lastKey);
  }
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
  The link mark keeps `javascript:`, `vbscript:` and `data:` URLs out of the HTML it reads and writes, in any case and
  with white space or control characters inside the scheme: such an `<a>` is read as plain text, and such an `href`
  is not written. Other URLs, an app's own schemes included, are read and written as they are.
  `unsetLink()` removes the link around the selection.
  On the desktops and the web in the desktop idiom, the pointer resting on linked text shows the link's `title` and
  destination below the pointer, as [TextView's links](./text-view.md) do; pressing and typing in the link work as
  before. Text an app's mark view renders shows what the app's element shows.
- `characterCount(options?)`: `editor.characters(mode?)` counts the text's characters (`"textSize"`, UTF-16 units as
  JS's `length`) or the document's positions (`"nodeSize"`); `editor.words()` counts its words (Unicode word
  boundaries). With `limit`, changes that would go past it are refused and pasted content is trimmed to what fits;
  a first document over the limit is trimmed (`autoTrim`). `setCharacterLimit(limit)` changes the limit and
  `editor.characterLimit` reads it.
- `suggestion(options?)`: follows a trigger (`char`, `@` by default) typed before the cursor. `allowSpaces` lets the
  query hold spaces, `allowedPrefixes` lists what may precede the trigger (a space by default; `anyPrefix` takes
  anything), `startOfLine` asks for it at the line's start (a `/` command menu). `editor.suggestion(key)` gives
  `{ active, range, query, text, lastKey, keyCount, open }`; the active range carries the app's `decorationClass` (and
  `decorationEmptyClass` while the query is empty). While a suggestion is active the keys in `captureKeys` belong
  to the app's list: the editor takes them and records the last one in the state, and Escape dismisses the
  suggestion (`exitSuggestion(key)` does too). `setSuggestionOpen(open, key?)` tells the suggestion whether the
  list shows for the query (its state's `open`): closed, the keys in `captureKeys` go on to the editor, so Enter
  sends or starts a new line when nothing matches, and Escape still dismisses. It holds for the query it was said
  for, so say it each time the query changes; until then the list is open and the keys are its own. A list that
  loads its items (a remote people search) closes only once it knows the list is empty, not while the results are
  still loading, or Enter would act before they arrive.
  A suggestion comes before `starterKit()` and the app's own keys in `plugins`, so its keys reach it first. `replaceSuggestion(content, key?)` replaces the trigger and the query
  with text or JSON content.
- `withMention(schema, { name?, char? })` adds Tiptap's mention node: an inline atom with `id`, `label` and its
  trigger, written as `@label` in text and as `<span data-type="mention">` in HTML. `insertMention(range, id, label?)`
  replaces a suggestion's range with a mention and a space.

The popup is the app's: it reads the suggestion's state, places itself at `coordsAtPos(range.from)` and draws the
items its own way.

## A block editor

A Notion-style editor is made of the pieces above, with the UI around the document the app's own. The gallery's Block editor demo (`examples/gallery/demos/BlockEditorDemo.tsx`) is one: a `/` menu of blocks, a handle on each block and a toolbar over a selection.

```tsx
import { Overlay } from "nsh";
import { RichEditor, StarterKit, chain, command, createRichEditor, defineExtension, deleteRange, suggestion } from "nsh/base";

// An extension ranks above the keymap, so Enter picks an item before it splits the paragraph.
const slash = defineExtension({
  name: "slashCommand",
  priority: 1000,
  addProseMirrorPlugins: () => [suggestion({ key: "slash", char: "/", captureKeys: ["ArrowUp", "ArrowDown", "Enter"] })],
});
const editor = createRichEditor({ extensions: [StarterKit, slash] });

// The menu goes in `bubbleMenu` while `editor.suggestion("slash")?.active`; a pick replaces the trigger and the query.
const { range } = editor.suggestion("slash")!;
editor.run(chain([deleteRange({ from: range.from, to: range.to }), command("toggleBulletList")]));

// A handle: the block under the pointer, and where it is on the page for an `Overlay` anchored there.
const start = editor.posAtPageCoords(event.pagePosition);
const rect = editor.pageNodeRect(start!);
editor.dragBlock(start!, { x: e.pageX, y: e.pageY }); // then dragTo(point) while moving, endDrag() on release
```

- The plugins of `createRichEditor`'s own `plugins` come after the extensions' and the keymap; a plugin whose keys must come first (a suggestion's Enter) is an extension with a high `priority`.
- `pageNodeRect(pos)` and `posAtPageCoords(point)` answer in page points, the coordinates of `Overlay`'s `anchor` and of pointer events, so a handle sits in the editor's margin as an overlay that follows the block.
- `dragBlock(pos, point)`, `dragTo(point)` and `endDrag()` move a block with the pointer: the drop line follows it and the drop is one undo step. A handle that also opens a menu on a tap claims the pointer only once it has moved (`onMoveShouldSetResponder`), so the tap keeps its `onPress`; a `Button` takes its own presses and passes the drag no responder.

## Tables

`TableKit` brings Tiptap's tables: `RichTable` (Tiptap's `Table`), `RichTableRow`, `RichTableHeader` and
`RichTableCell`. It is added next to `StarterKit`:

```tsx
import { RichEditor, StarterKit, TableKit, addRowAfter, createRichEditor, insertTable, mergeCells } from "nsh/base";

const editor = createRichEditor({
  extensions: [StarterKit, TableKit.configure({ table: { cellMinWidth: 40 } })],
});

editor.run(insertTable({ rows: 3, cols: 3, withHeaderRow: true }));
editor.run(addRowAfter());
```

The table takes the options `resizable` (true), `cellMinWidth` (25), `lastColumnResizable` (true),
`allowTableNodeSelection` (false) and `HTMLAttributes`; `TableKit.configure({ tableHeader: false })` leaves one
extension out. Cells hold blocks and have `colspan`, `rowspan` and `colwidth` (a width in points per column they
span); rows have a `height`.

Tab and Shift-Tab move between cells, and Tab in the last cell adds a row. Arrow keys at a cell's edge go on to the
next cell; Shift with an arrow, or a drag across cells, selects a rectangle of cells (a selection of the type
`"cell"`, whose `anchor` and `head` are the positions before its first and last cells). Backspace and Delete empty
the selected cells, and delete the table when all its cells are selected.

Columns fit the text and components in their cells. Long paragraphs wrap, and a table wider than the editor
scrolls horizontally inside the document. A saved or dragged column width takes precedence. Each column is at
least `cellMinWidth` wide and each row is at least its saved `height`. Its look starts from the theme: a
1-point `border` grid, header cells on `muted`, padded cells, and each selected cell under the `selectedCell` part in
the selection color. `classes.nodes` (`table`, `tableCell`, `tableHeader`) and the parts restyle
all of it. Up and Down on a cell's first or last line go to the cell above or below.

While the document can be edited:

- On desktops, the right border of each column and the bottom border of each row resize them: the pointer shows the
  resize cursor and the `tableResizeHandle` line, the table follows the drag, and the release sets `colwidth` or
  `height` in one step that undo takes back. `resizable: false` turns this off, `lastColumnResizable: false` keeps the
  last column's width.
- The table the selection is in shows grips (`tableGrip`) on its top border over each column and on its left border
  beside each row. Pressing one selects that column or row; dragging it on desktops shows where it drops
  (`tableDropIndicator`) and moves it there on release.
- A grip pressed and let go without dragging (a tap on touch screens) calls `onTableMenu` after it selected its
  column or row, with `{ table, row, column, bounds }`: `table` is the position before the table, `row` is set for a
  row's grip and `column` for a column's, and `bounds` is the grip's box in the root view, where the app opens its own
  menu for that row or column. A drag moves the row or column and does not call it, nor does a
  release after the grip's table or line went away.

```tsx
<RichEditor
  editor={editor}
  onTableMenu={({ table, row, column, bounds }) =>
    openLineMenu({ table, row, column, anchor: bounds })
  }
/>
```

```tsx
<RichEditor
  editor={editor}
  classes={{
    nodes: { tableHeader: "font-semibold", tableCell: "px-3 py-2" },
    selectedCell: "bg-primary/10",
    tableGrip: "bg-muted-foreground/60 rounded-full",
  }}
/>
```

The commands, each a helper of `nsh/base`:

- `insertTable({ rows, cols, withHeaderRow })` (3 × 3 with a header row by default) and `deleteTable()`.
- `addColumnBefore()`, `addColumnAfter()`, `deleteColumn()`, `addRowBefore()`, `addRowAfter()`, `deleteRow()`.
- `mergeCells()`, `splitCell()` and `mergeOrSplit()`.
- `toggleHeaderRow()`, `toggleHeaderColumn()` and `toggleHeaderCell()`.
- `setCellAttribute(name, value)`, `setCellSelection({ anchorCell, headCell })`, `goToNextCell()`,
  `goToPreviousCell()` and `fixTables()`, which repairs tables with missing or overlapping cells.
- `moveTableRow({ from, to, select })` and `moveTableColumn({ from, to, select })` move a row or column, together
  with the rows or columns its merged cells span; `setColumnWidth({ col, width })` and
  `setRowHeight({ row, height })` size them (`null` sizes them to their content). These take `table`, the position
  before a table, to act on a table other than the selection's.

Tables read from and write to HTML (`<table>` with `<th>` / `<td>`, `colspan`, `rowspan` and `data-colwidth`) and
Markdown: a table with a header row whose cells are each one paragraph is a GFM pipe table, and any other table is
written as its HTML, which reads back the same. In plain text a row is a line of its cells separated by tabs.
