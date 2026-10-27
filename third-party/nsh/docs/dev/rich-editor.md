# RichEditor

`RichEditor` is `nsh/base`'s rich text editor. Its kernel (`crates/nsh-base/src/rich_editor/`) follows ProseMirror's
architecture: a document whose structure a schema defines, changes as steps grouped into transactions, immutable
editor states, commands, plugins, and adapters to the formats apps store. The kernel is headless: it depends on no view
and is tested on its own; the native view renders its states and turns the platform's input into transactions.

## Credits

The kernel is a Rust port of [ProseMirror](https://prosemirror.net) (`prosemirror-model`, `-transform`, `-state`,
`-commands`, `-schema-list`, `-history`, `-keymap`, `-inputrules`, `-gapcursor`, `-dropcursor`, `-tables`; MIT,
© Marijn Haverbeke and others), and the extension layer follows [Tiptap](https://tiptap.dev) (MIT, © Tiptap GmbH):
data structures, algorithms, names, options and command semantics come from them, and their MIT licenses apply to
what is ported. A module ported from one names its source in its module doc; keep that when adding one.

## Modules

| Module | What it holds |
|---|---|
| `model/` | `Schema` (node and mark types from a `SchemaSpec`, content expressions compiled to `ContentMatch` automata), `Node`, `Fragment`, `Mark`, `Slice`, `ResolvedPos`, `NodeRange`; `Node::replace` after ProseMirror's `replace.ts`; ProseMirror's JSON shape |
| `transform/` | `Step` (an object-safe trait: `ReplaceStep`, `ReplaceAroundStep`, `AddMarkStep` / `RemoveMarkStep`, `AddNodeMarkStep` / `RemoveNodeMarkStep`, `AttrStep`, `DocAttrStep`), `StepMap` / `Mapping`, `Transform` and the structure helpers (lift, wrap, split, join, `replace_step`'s fitter) |
| `state/` | `EditorState`, `Transaction`, `Selection` (text, node, all, custom), plugins and decorations |
| `commands/` | prosemirror-commands and prosemirror-schema-list: `Command`s over a state and an optional dispatch, `chain_commands`, `base_keymap` |
| `extensions/` | optional behavior as plugins: `history`, `keymap`, `input_rules`, `markdown` (Markdown shortcuts as you type, Markdown paste and copy, mapped by `MarkdownNames`); `starter`, the optional starter schema (paragraphs, headings, quotes, code, lists, images, the common marks) with its keymap and input rules |
| `formats/` | `DocFormat`: `JsonFormat`, `PlainTextFormat`, `MarkdownFormat` (names mapped by `MarkdownNames`), the clipboard's `slice_to_text` / `slice_from_text` |

## Documents defined by the schema

The kernel knows no node or mark by name. A document's types, their content (`"paragraph+"`, `"inline*"`,
`"(heading | paragraph) block*"`), groups, attributes with defaults and validation, allowed marks and mark exclusion
are the schema's, written in Rust (`SchemaSpec`) or JSON (`SchemaSpec::from_json`). The first block type is the
default one (what `Enter` creates, what fills required content). `starter` is a schema like any app's, not a part of
the kernel; formats and commands take type names or types as parameters.

## Steps and transactions

Every change is a step: it applies to a document or fails, has a `StepMap` that maps positions across it, inverts
against the document it applied to, maps over other changes, may merge with the next one and serializes to JSON. A
`Transform` collects steps, the documents between them and the mapping of all of them; a step that fails leaves the
transform unchanged.

A `Transaction` is a transform with the state's selection, stored marks, metadata and an origin
(`TransactionOrigin`: user, input, paste, drop, remote, history, plugin, API). One user action is one transaction: a
keystroke, a paste, a command, an IME commit. `EditorState::apply_transaction` applies it atomically: plugins'
`filter_transaction` may refuse it, the new document must pass `Node::check` against the schema, and plugins'
`append_transaction` results are applied too, or nothing is (`StateError`).

## Positions

Positions are ProseMirror's linear positions: a text counts its length, a leaf node one, a node with content its two
boundaries. Text lengths are UTF-16 code units, as the platforms' text systems and JS count them (texts are stored as
UTF-8; `model::utf16_to_byte` converts). Commands and the view move by grapheme clusters, never inside one, and never
split a surrogate pair. A text selection's head has an `Affinity` (upstream, downstream) that says on which side of a
line wrap or a bidi boundary the caret shows. Positions shift with every change: anything that must outlive edits
(comments, anchors, collaboration) keeps an id in a node's attributes or a mark, never a position, or maps its
positions through each transaction's `mapping`.

## Editor state

`EditorState` is immutable and cheap to clone. It holds the schema, the document, the selection, the stored marks (the
marks the next typed text gets, set by toggling a mark at a cursor and cleared when the selection moves), the plugins
and their states, and a revision that counts applied transactions. `apply` returns a new state; the old one stays
valid, which is what history, diffing and the view's updates rely on. States read from and write to JSON.

## Selections

`Selection` is `TextSelection` (anchor and head in inline content), `NodeSelection` (one selectable node),
`AllSelection` (the whole document) or a custom kind an extension implements (`CustomSelection`: table cells, gap
cursors). Every kind maps through changes, gives its content as a `Slice`, replaces it, and has a bookmark that maps
without a document. `Selection::near` / `find_from` find a valid selection where a position is not one.

## Plugins

A plugin is an `Arc<dyn PluginSpec>` with a unique `PluginKey`; two plugins with one key are an error when the state is
created. Its hooks:

- State: `init_state` when the state is created, `apply_state` for each applied transaction, in plugin order.
- `filter_transaction`: any plugin may refuse a transaction before it applies.
- `append_transaction`: after a transaction (or a round of them) applies, each plugin in order may return one more,
  seeing only the transactions it has not seen. Rounds repeat until no plugin appends; more than 64 rounds is
  `StateError::AppendLoop`, so two plugins answering each other cannot hang the editor.
- Events: `handle_key_down`, `handle_text_input`, `handle_paste` are asked in plugin order and the first that returns
  `true` consumes the event; the view's default handling runs only when none does. Keymaps and input rules are plugins
  of this kind, so their order in the plugin list is their priority.
- `decorations`: inline, widget and node decorations the view draws without changing the document.
- `view_created` / `view_updated` / `view_destroyed`: the plugin's part of a view's life.

Asynchronous work (a link preview, a spell check, a server's answer) never edits a stored state: when the result comes
back it builds a new transaction against the state current then, maps positions it remembered through the changes
since (or looks nodes up by id), checks that what it targets still exists, and dispatches.

## Node views

A node type can have a node view: native UI for a node (an image with a caption, an embed, a math block, a checkbox in
a task item). Its contract:

- `create(node, decorations)`: the view for a node.
- `update(node, decorations) -> bool`: the node changed; `false` has the view recreated.
- `editable_content_slot`: where the node's content renders and stays editable, if it has any; without one the node is
  an atom the view treats as one unit.
- `select` / `deselect`: a node selection takes or leaves the node.
- `handle_event(event) -> bool`: events inside the view; `true` keeps them from the editor.
- `destroy`: the view is gone.

A node view never mutates its node: an attribute change (a resized image, a toggled checkbox) is a transaction
(`set_node_attribute`), so it is undoable, mapped, collaborated and checked like any other change.

## The native view (`rich_editor/view/`)

`RichEditor` (`nsh/base`) is a Rust component over an `EditorSession` (`view/session.rs`): the one live editor the
view and the app share (`Arc<Mutex<…>>`, `Send + Sync`). The session holds the state, applies transactions
(`dispatch`, or the app's `set_dispatch_transaction` committing with `update_state`), runs commands (`run`, `can`,
`is_active`) and notifies subscribers; `focus` / `blur` are requests to the views showing it. The JS class crosses
through `SessionJs` (`set_session_js`), the `editor` prop's decoder. Without an `editor`, the view makes its own
session from `schema` / `content` JSON and built-in `plugins` by name (`starter`, `history`, `baseKeymap`,
`markdown`).

Data flows one way. The view subscribes to the session (on the engine thread; changes made on other threads show
with the next one made there) and on each new state: gives the document's blocks ids (`controller.rs` `Tree`: a block
keeps its id while it is the same node, or the node at its index with its type), collects the plugins' decorations
and reports `change` (the revision only: the document is read on demand, `docJson()`) and `selectionChange`.

Rendering (`render.rs`): a scroll view of the content box, holding the selection's boxes, the blocks, the
placeholder, the caret and the composition. A block is a view keyed by id whose classes and styles are its node's
part (`classes.nodes` / `styles.nodes` by type name, then `type[attr=value]`), node decorations' `class` and the
`selectedNode` part. Containers hold their children's views; the children of a node whose spec's `extra.listMarker`
is `"bullet"` or `"ordered"` (the starter's lists) carry a marker the view draws in the `listMarker` part, absolutely
placed in the indent before the item (`•`, `◦`, `▪` by bulleted depth, or the number from the list's
`extra.listMarkerStart` attribute, `order` by default), as TextView places its markers; it is not in the document and
takes no positions; a textblock is one text whose spans are its texts with
their marks' parts (`classes.marks`), split at inline decorations (their `class`); inline leaves are their one-unit
`leafText` (a line break) or attachments (their node view, else a box of their part); widget decorations are
attachments with their spec's `class`. A node view (`node_view.rs`: `NodeView`, registered in `NodeViews` or a
plugin's `node_views` as an `Arc<dyn NodeView>`) renders a node type's blocks: `create` makes the element, which
follows `cx.node()` while `update` returns true; `editable_content_slot` puts the editor's rendering of the content
(`cx.take_content()`) inside it, measured in the content box; otherwise the node is an atom selected and moved over
as a unit. The only looks of the view's own are the caret (2 points, the theme's `foreground`), the selection (the
theme's selection color), the placeholder (`muted-foreground`) and the composition (underlined), each a part the app
restyles.

Geometry (`geometry.rs`): blocks report their frames (`onLayout`), each textblock's text its lines as the core laid
them out (`onTextLayout`), and an `InlineMap` maps the textblock's positions to the text's offsets (atoms and
widgets are one character). Positions within a line are placed by the relative widths of grapheme prefixes, so the
caret and hit tests follow the app's fonts (classes included) line by line. Document positions and places stay
apart: a position at a wrap shows at the upper line's end with `Affinity::Upstream`.

Input (`controller.rs`): as the code `Editor`, an invisible native input at the caret (the sink) takes typed text
and input methods. Typed text goes to plugins' `handle_text_input` (input rules), else is inserted with the stored
marks (origin `Input`). While an input method composes, its text shows at the caret and the document waits; the
commit is one transaction tagged with the composition's id (`composition` meta, which the history groups). Keys: the
view binds, while focused, every keystroke a keymap could use (`keys.rs`) and offers each as a `KeyEvent` to the
selected node's view, the plugins' `handle_key_down`, the base keymap, then copy / cut / select all and the caret
movement (graphemes, words, line ends, lines and pages by geometry, keeping the goal x, the document's ends).
Presses: a node view's `handle_event`, the plugins' click hooks (`handle_click_on` per ancestor, then
`handle_click`, double and triple likewise), then a caret (Shift extends), a word, the textblock or a node selection;
a drag extends through `create_selection_between`, and past the viewport's top or bottom it scrolls the view on a timer (the code `Editor`'s `AutoScroll` and `edge_speed`) and extends again at each step. Paste: `transform_pasted_text`, `clipboard_text_parser` (else
`slice_from_text`), `transform_pasted`, `handle_paste`, else a replace of the selection (origin `Paste`). Copy:
`clipboard_text_serializer`, else `slice_to_text`.

The bubble menu (`bubbleMenu`, a slot): an empty box over the selection's lines (`Rv::selection_box`), inside the
content box so it scrolls with the text, anchors an `overlay()` holding the app's content (`bubbleMenuPlacement`,
`bubbleMenuOffset`); the overlay flips and stays on screen as the core's overlays do. Whether it shows is the app's:
it passes the slot while it wants the menu.

## The JS API (`rich_editor/js/`)

```tsx
import { createRichEditor, RichEditor, history, keymap, inputRules, markdownRules, markdown, toggleMark } from "nsh/base";

const editor = createRichEditor({ schema, doc, plugins: [history(), keymap({ "Mod-b": toggleMark("bold") }), inputRules(markdownRules()), markdown()] });
editor.run(toggleMark("bold")); editor.can(toggleMark("bold")); editor.isActive("bold");
editor.dispatchTransaction = (tr) => editor.applyTransaction(tr);

<RichEditor editor={editor} class="…" />;
```

- `RichEditorSession` (`#[class]`) holds an `EditorSession` and the schema; `createRichEditor` makes one, and the
  session's `SessionJs` bridge (registered by `js::register`) turns an instance into the view's `editor` prop.
  States, documents, selections and transactions cross as JSON only when the app asks, typed by declared interfaces
  (`RichNodeJSON`, `RichTransactionJSON`, ...; `json.rs`). `defineSchema` reads `nodes` / `marks` objects in the JS
  object's key order (`JsIn::keys`), since serde_json's maps sort their keys.
- Commands and kernel plugins are data (`RichCommand`, `RichPluginSpec`, `RichInputRule`: `JsObject`s made by
  `toggleMark(..)`, `history(..)`, `markRule(..)`, ...), resolved against the editor's schema when they run or the
  editor is made (`commands.rs`, `plugins.rs`). `chain` runs commands on the states each leaves and dispatches their
  steps as one transaction; `first` is ProseMirror's `chainCommands`.
- `RichEditorPlugin` (`#[class]`) is a plugin whose behavior is the app's. Its callbacks live in a thread-local table
  of the engine thread (`HookRef`), since the kernel's plugins and the session are `Send + Sync`. Captured keys are a
  native keymap consumed while `capturing` is set, reported to JS with `post`; decorations are data a transaction
  carries under the plugin's key and the plugin maps natively; `filterTransaction` / `appendTransaction` are called
  with `Callback::call` only inside the app's own synchronous calls (`CallGuard`), so the platform's input never
  waits for JS. `dispatchTransaction` is called in the app's calls and posted for input; the Rust transaction waits
  under its `id` until `applyTransaction` takes it, keeping its Rust metadata (history).
- Methods that may run JS hooks (`run`, `dispatch`, `setContent`, ...) take `this: Instance<Self>` rather than a
  borrow, so a hook calling the editor again (`applyTransaction` from `dispatchTransaction`) is not re-entrant.

## Extensions: the Tiptap layer

The kernel is ProseMirror; the layer apps and third parties build with is Tiptap's: an **extension** contributes, in
one unit, to the schema (node and mark types, attributes on other types), the commands, the keymap, input and paste
rules and plugins, ordered by priority. NSH keeps Tiptap's names and semantics and changes one thing: logic is Rust,
JS describes.

- **`Extension`** (`extensions/extension.rs`): `name`, `kind` (`Extension`, `Node`, `Mark`), `priority` (100 by
  default, `DEFAULT_PRIORITY`; higher first, as Tiptap's `sortExtensions`), `options` (JSON), `top_node`, and parts
  that are functions of the options, set with builder methods named as Tiptap's hooks:
  - the schema stage: the node or mark spec (`Extension::node` / `Extension::mark`, `with_node_spec`),
    `add_global_attributes` (`GlobalAttributes`: attributes added to, or replacing those of, other types),
    `add_extensions` (children);
  - the runtime stage, from an `ExtensionContext` (name, options, the built `Schema`, the editor's
    `CommandRegistry`): `add_keyboard_shortcuts`, `add_input_rules`, `add_paste_rules`, `add_plugins`
    (`addProseMirrorPlugins`); and `add_commands` (name → `CommandFactory`), `add_storage`.
  `configure(options)` deep-merges into the options (`merge_options`, Tiptap's `mergeDeep`); `with_options` gives
  defaults under what was configured; `extend()` is a copy whose parts the builders replace (keep a clone to call the
  parent's). Every part is an `Arc`'d `Send + Sync` function, so extensions are cheap to clone and share.
- **`ExtensionManager`** resolves a list: `resolve` flattens each extension followed by its children, sorts stably by
  priority and refuses duplicate names (`ExtensionError::DuplicateName`); `schema_spec` collects the nodes and marks
  in that order (the first `top_node` names the document) and applies the global attributes; the commands are the
  built-in registry's plus every extension's, later ones replacing earlier ones. The runtime order is Tiptap's
  (`runtime_order`: the list reversed, then sorted by priority), so an app's extension listed after the starter kit
  binds before it and the core runs last. `plugins()` is the input rules' plugin, the paste rules' plugin, **one**
  keymap plugin merging every extension's bindings in runtime order (`merge_keymaps`: a key's commands run until one
  applies), then each extension's plugins. One merged keymap rather than Tiptap's one plugin per extension: the
  keymap tries a binding with Shift spelled out before the shifted character's, and that must hold across
  extensions (`Mod-Shift-b`, the quote, over bold's `Mod-B`). `with_core` puts the core extensions first
  (`core_extensions`: `keymap`, the core keymap and `clearDocument`).
- **The built-in extensions** (`extensions/kit.rs`): `document` (`doc`), `paragraph`, `text`, `heading` (`levels`),
  `blockquote`, `bullet_list`, `ordered_list`, `list_item`, `task_list`, `task_item` (`nested`), `code_block`
  (Tiptap's code block options), `hard_break` (`keepMarks`), `horizontal_rule`, `image`, the marks `bold`, `italic`,
  `strike`, `code`, `underline`, `link`, `highlight`, `subscript`, `superscript`, `text_style`, and `text_align`
  (`types`, `alignments`, `defaultAlignment`: a global attribute), `history` (`depth`, `newGroupDelay`),
  `trailing_node` (`node`, `notAfter`), `typography` (each replacement `false` or a string), `list_keymap`; each with
  its Tiptap commands (`toggleBold`, `toggleHeading({ level })`, `toggleBulletList`, `setTextAlign`, ...).
  `starter_kit()` brings them all, in the starter schema's order; an option named as one (`document` for `doc`,
  `history` or `undoRedo`) set to `false` leaves it out, an object configures it. `builtin(name)` finds one. The
  starter's plain functions (`starter::schema`, `schema_spec`, `keymap`, `plugins`, `input_rule_list`,
  `paste_rule_list`) are made from the same pieces, the schema and plugins by a manager of the core and the kit.
  Link's autolinking, CharacterCount and Suggestion are plugin factories with options structs (below); an extension
  wraps one with `Extension::new("characterCount").with_options(...).add_plugins(|cx| ...)`, reading its options
  struct from `cx.options`.
- **By name**: `register_extension(name, make)` registers an extension on the engine (a `global`), and
  `extension_named(name)` finds it, else a built-in one. An app's crate registers from its `#[native_module]`
  function with `registry.rich_extension(name, make)` (`RichExtensionRegistry`, which runs `register_extension` in
  the set's setup); JS gets it with `richExtension(name, options)`.
- **Commands** are named (`toggleHeading`, `setLink`, ...) with JSON arguments: an extension's `commands` map a name
  to a Rust factory `fn(args) -> BoxCommand`. JS runs them as data, `command("toggleHeading", { level: 2 })` (or the
  typed helpers `nsh/base` exports), composes them with `chain` / `first`, and asks `can`. Commands never take a JS
  closure: one would run QuickJS on the input path. App crates add extensions, and so commands, plugins and node views
  in Rust, through their UI set (`#[native_module]`), which registers them by name for JS to use.
- **Queries** are native: `isActive(name, attrs)`, `getAttributes`, `getMarkRange`, `findParentNode`, `coordsAtPos`,
  `posAtCoords`, `selectionRect`; JS reads them on the revision it subscribes to. The three geometry queries answer
  in points of the editor's content box (the box that scrolls, so its scroll offset is already in them) from the
  last view that mounted the session (`ViewGeometry`, registered by the controller); with no view they answer
  nothing. The view tells the session its focus (`isFocused`, `focus` / `blur` events) and honors `setEditable`.
- **Events**: `create`, `update`, `selectionUpdate`, `transaction` (a summary), `focus`, `blur`, `paste`, `drop`,
  `delete`, `destroy`, posted to JS after the fact.
- **Formats**: JSON (Tiptap's document JSON loads as is), Markdown (each type's form declared by its extension), HTML
  (parse rules and `toDOM` per type, `DomParser` / `DomSerializer`), text (`renderText` per type).
- **JS face** (`js/extension_api.rs`): `createRichEditor({ extensions: [StarterKit.configure({ heading: { levels:
  [1, 2, 3] } }), Underline], content, editable })`. The built-in extensions are classes whose statics make them
  (`configure`, `extend`); a class itself in `extensions` is the extension with its defaults (`ExtensionEntry` reads a
  function's `name`). `RichExtension` (what they make) has `name`, `type`, `priority`, `options`, `configure` and
  `extend`. Tiptap's `Image` is `RichImage` (`Image` is the core's), `TextStyle` is `RichTextStyle` (`TextStyle` is the style type; a test of `nsh-js`'s declarations keeps exports from shadowing shared types) and `Text` is `richExtension("text")`.
  `defineExtension({ name, priority, node | mark, topNode, addOptions, addKeyboardShortcuts, addCommands,
  addInputRules, addPasteRules, addProseMirrorPlugins, addGlobalAttributes, addStorage })` declares the app's: its
  functions run once, in `createRichEditor` (a synchronous call, where JS runs anyway), with the extension's options,
  and return data (commands, rules and plugins as data, `RichEditorPlugin`s), which `to_extension` turns into a Rust
  `Extension`. Errors found when the schema is known (an unknown type in a binding) collect in `Diagnostics` and
  make `createRichEditor` throw. The session keeps the manager's `CommandRegistry`, so `command("toggleBold")` and
  the extensions' commands resolve per editor. `schema` + `plugins` stay the kernel-level way to make an editor;
  with `extensions`, `schema` is refused and `plugins` come after the extensions'.

## Link, CharacterCount, Suggestion (`extensions/link.rs`, `character_count.rs`, `suggestion.rs`)

Tiptap's three behaviors as plain plugin factories with an options struct (`LinkOptions`, `CharacterCountOptions`,
`SuggestionOptions`, each with Tiptap's defaults), so an extension can wrap each as is. Their commands are named
commands of the built-in registry (`register_commands` of each module): `setLink`, `toggleLink`, `unsetLink`,
`setCharacterLimit`, `exitSuggestion`, `replaceSuggestion`, `insertMention`.

- **Link** (`link(options) -> Vec<Plugin>`): a `link` plugin keeping the options in the state (the commands read
  the allowed protocols there), `autolink` (`append_transaction`: the changed ranges of the transactions mapped to
  the new document; a range ending in white space, or spanning two textblocks after Enter, has its last word checked
  with `word_link`, linkify's `isValidLinkStructure`; history transactions, `preventAutolink` and code marks are
  skipped), `handleClickLink` (`handle_click`: Mod or a read-only editor opens the link through `LinkOptions::open`,
  NSH's `open_url` by default, so the embedding app's URL handler sees it first) and `handlePasteLink`
  (`handle_paste`: a URL pasted over a selection links it; `transform_pasted`: URLs in pasted text are linked).
  `find_links` is the detector: URLs with a protocol, host names whose top-level domain is a known one (every
  two-letter country code and a list of generic ones), e-mail addresses; trailing punctuation and unbalanced
  closing brackets stay outside, as linkify's. `is_allowed_uri` is Tiptap's expression; `should_auto_link` is
  Tiptap's default (no IP addresses or dotless hosts without a protocol). The starter's link mark is not inclusive,
  so the white space typed after a link never joins it.
- **CharacterCount** (`character_count(options) -> Plugin`, key `characterCount`): its state holds the current
  limit (the `characterCount` meta of `setCharacterLimit` changes it) and the options, which `characters(state,
  mode)` / `words(state)` / `character_limit(state)` read. `filter_transaction` refuses a change that grows the
  count past the limit (a document over it already may shrink). The kernel's filters see a transaction and do not
  change it, so the paste trimming Tiptap does in its filter happens in `transform_pasted`: the longest start of
  the pasted slice whose result fits (a binary search over the slice's positions, each candidate applied with
  `Node::replace` and counted). The first transaction trims a first document over the limit (`auto_trim`).
- **Suggestion** (`suggestion(options) -> Plugin`, keyed by `options.key`): `find_suggestion_match` is Tiptap's
  (the look-ahead of `allowSpaces` scanned by hand, as Rust's `regex` has none); the state follows Tiptap's
  `apply` (exit meta, dismissed range mapped and kept until white space is typed or the trigger moves, inactive
  outside the range or with a selection). `handle_key_down` while active: Escape runs `on_key_down` and dispatches
  the exit meta; then `on_key_down`; then `capture_keys` are taken and recorded in the state (`last_key`,
  `key_count`, a meta-only transaction outside the history), which is how JS's list hears its keys without the
  input path waiting for JS. `decorations` gives the active range the options' classes. `mention_node` /
  `insert_mention` are Tiptap's Mention (the text `char + (label ?? id)`, a space after it, a space already there
  taken in).

The JS face (`js/extensions.rs`): `link`, `characterCount`, `suggestion` (plugin specs of the kinds `Link`,
`CharacterCount`, `Suggestion` with typed option objects), `withMention`, the command helpers, and the session's
`suggestion(key)`, `characters(mode)`, `words()` and `characterLimit`.

## Phases

1. The headless kernel: model, transform, state, commands, history, keymaps, input rules, the starter schema, formats.
   Done.
2. The native view: rendering, selection and caret, input and IME on each platform, node views, decorations.
3. The base extensions as components (lists, links, images, tables, mentions), `createRichEditor` and `<RichEditor>`
   with their declarations and compat cases; the gallery and website examples.

## Future work: collaboration

Steps are already what collaboration needs: they serialize, map and rebase, transactions carry a `Remote` origin and
the history skips remote changes while mapping its own over them. A collaboration extension (prosemirror-collab's
central authority, or a CRDT binding) comes after the view.
