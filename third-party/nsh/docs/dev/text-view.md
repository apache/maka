# TextView

`TextView` (`nsh/base`, `crates/nsh-base/src/text_view/`) shows a document of Markdown, HTML or the app's own blocks
with the primitives: texts with spans, views, scroll views and images. It is the port of gpui-kit's `TextView`, made
for the replies of AI models in chat UIs: Markdown that streams in chunk by chunk, with code, tables, formulas and the
app's own syntax (mentions, charts, callouts). It owns behavior (parsing, links, disclosures, accessibility) and,
unlike the other `nsh/base` components, has a default reading typography (the one exception to "No styles in NSH"),
colored with the theme's tokens; the app restyles each part over it.

| File | What |
|---|---|
| `view.rs` | The component: `TextViewProps`, `TextViewEvent` (`LinkPress`), `TextViewMath`, `CodeHighlighter` (context); the blocks made with primitives (`Cx`) |
| `document.rs` | The document model (`Document`, `Block`, `Inline`, `CodeBlock`, `Table`, `Image`, `CustomNode`, ...): serde data, JSON in JS, its TypeScript declarations (`TextViewDocument`, `TextViewBlock`, ...) |
| `parts.rs` | The parts the app styles: one `parts!` list makes `TextViewClasses`, `TextViewStyles` (each a `PartStyle`, a `Style` declared `StyleProp<TextStyle>`, since most parts are texts) and `TextViewPart`; `TextViewParts` (context): typed `StyleRefinement` functions by part for Rust views |
| `extension.rs` | `MarkdownOptions`, `MarkdownExtension` (declared syntax), `MarkdownPlugin` / `MarkdownPlugins` (Rust), `Parser` |
| `markdown/` | Markdown into the model (markdown-rs's mdast); `container.rs`: `:::` containers, split out before parsing (markdown-rs has no such syntax); `streaming.rs`: streaming repair |
| `html/` | HTML into the model (html5ever, as a reader mode reads a page) |
| `common.rs` | What both parsers share: `pattern` extensions on inline content, headings' anchors |

## How it works

- **Parsed in Rust by one component-owned worker.** Source changes replace its latest request. One `blocking`
  parse finishes before the worker starts the newest request; it constructs the parser and plugin options on that
  thread. A completed Markdown prefix may be published while a compatible append is pending. A replacement,
  source identity, input mode or parser configuration change rejects that result. Disposing the component cancels
  publication. Before the first result, and after a parser failure (`onParseError`), the full current input is shown
  literally. The same parser is public for Rust callers and the static parsing functions.
- **Canonical source positions.** `sourceId` names the original Markdown document for reading anchors. Native
  source wrappers on inline leaves, code blocks and formulas carry Core's `TextSourceSegment`s onto the actual Text owners;
  UTF-8 addresses are projected through line-ending normalization, streaming repair, TeX rewriting, container slices
  and reference definitions. Synthetic repair syntax has no original address. These wrappers stay native; JSON
  renderer payloads contain their displayed content. HTML text with decoding or whitespace collapse is an explicit
  replacement of its originating Markdown HTML node; its processed offsets never stand in for original addresses.
  Selection continues to use the real selectable texts.
- **Root blocks use a native parent-viewport list.** The scroll view around the document remains its reader;
  only blocks near that viewport are mounted. A recycled cell has a single keyed logical owner for its block's
  position and kind. Compatible appends retain that owner; a paragraph becoming a table replaces it, so callbacks
  and link focus capabilities never follow the cell into another block. Footnotes form the final row. Containers
  still use the same recursive renderer within their root block. `contentStyle: ListContentStyle` lays out these
  rows with point-valued padding and gaps (default `rowGap: 11.25`). A supplied value replaces the complete content
  layout, so `{}` and `{ rowGap: 0 }` both select zero gap. Root `classes` / `styles` own outer geometry and text
  appearance; document content spacing belongs to `contentStyle`.
  A whole-source literal fallback has its own row identity; parsed blocks do not inherit its size or callbacks.
  The native Markdown publication also carries its captured source length and each root row's canonical ranges,
  collected by the same converter. `VirtualList::source_rows` publishes this immutable index as `ListSourceRows`;
  the current input supplies the complete source length. The surrounding reader keeps its one source pin while
  a required prefix or row is pending, binds that row and its ancestor cells through the normal list window,
  then resolves its actual text geometry. Other mounted rows do not stand in for a missing source position.
- **Built on `Text`** (`text.md`): every paragraph, heading, table cell and code block is one native text
  block, so wrapping, font scale, selection, span backgrounds (inline code), pressable
  spans (links) and inline attachments (images, inline custom nodes, the caret) are the text element's, with nothing of
  `TextView`'s own; the website page links to the Text page for them rather than describing them again.
- **Each block is made with primitives** (`Cx::block`): a paragraph or heading is one `text` whose children are spans
  (`Inline` → nested texts, inline images, slots), lists are rows of a marker text and a column, code blocks a column
  with floating actions and a horizontal `scroll`, tables one grid in a horizontal `scroll` (below), disclosures a
  pressable summary and an `If`. With `selectable`, document texts carry `userSelect: "text"` (`.select_text()`), while decorative/control texts opt out with `userSelect: "none"` (`.select_none()`). The root is a selectable view
  (`Element::selectable`), so one selection runs across the mounted blocks, and inside a selectable view on into the
  mounted texts around the view ("Selectable views" in `text.md`).
- **Tables** (`Cx::table`) lay out as gpui-kit's: columns fit their content when there is room, shrink (their cells
  wrapping) down to a floor per column when the view is narrower, and below the floors the table scrolls horizontally
  (`tableScroll`; `tableScrollbar` hides its indicator, as `codeBlockScrollbar` a code block's). The cells are one CSS grid, so columns line up across rows: each column is a `minmax(<floor>,
  auto)` track (the spare width is shared out as CSS shares it among `auto` tracks), and the grid is `w-full` with
  the floors' sum as its `min-width`, so past the floors it is wider than the scroll view. Taffy has no
  `display: contents` and text has no min-content (longest word) measure, so the floor is computed in the component
  (`column_floor`): about half the column's widest line, estimated from the cells' text (wide characters an em, the
  rest about half), clamped to 10–30 rem, or the whole line plus 2 rem for padding when that is narrower. A row is a
  view behind its cells (`row_start`, `col_span_full`, before them in the grid), so `tableRow` / `tableHead` draw
  backgrounds and borders; their text styles do not reach the cells, which are siblings (`tableCell` /
  `tableHeaderCell` take them).
- **The caret slot** (`streamingCaret`, `streaming_caret`, `Option<Slot>`) is placed inline at the end of the last text of the last block
  (descending into quotes, lists and custom nodes' content; after the code of a code block; a table's last cell), else
  on a line of its own after the last block (a rule, a render function's content), so it follows the text as it
  streams.
- **Static functions** (`#[module] impl TextView`, synchronous): `TextView.parse(markdown, options?, extensions?)`,
  `TextView.parseHtml(html, extensions?)` and `TextView.plainText(document)` (`Document::plain_text`: what copying a
  whole reply gives); in Rust the same associated functions. The document types stay under `nsh_base::text_view`
  (short names such as `Block` and `Image` would clash at the crate root); their TS names are `TextView*`.
- **Render functions** (`Option<Renderer<T>>` props, `docs/dev/components.md`) put the app's content in place of a part
  (`renderCodeBlock`, `renderMath`, `renderImage`, `renderCustom`) or beside it (`renderCodeBlockAction`, the icon of an
  app's action in `codeBlockActions`, `renderTableActions` above a table). Code block actions are `TextView`'s ghost
  buttons (24 pt, a background while hovered or pressed); `copy` is built in (the clipboard, then a check that springs
  in and fades back after 1.6 s); a press reports `onCodeBlockAction`. Each render has a key of the block's position (`code:3`,
  `math:2.0.1`, ...); content rendered for a key stays while the value is equal, so a streamed reply renders the app's
  code blocks again only while they are being written.
- **Links report presses**: `onLinkPress({ url, target })`; a heading's anchor is `#<slug>` (GitHub's slugs, `common.rs`), a
  footnote reference `#footnote-<label>`. By default nothing opens a URL: the app decides. `links="open"`
  (`TextViewLinks::Open`, opt-in) also opens a link with a scheme after reporting it (`nsh_core::element::open_url`,
  under the `openUrl` capability and the embedding app's URL handler), never an anchor (`#…`): `Cx::link_press`. `target` is the original native Link's focus capability;
  `target.focus()` accepts a restoration request while that Link lives, then applies it natively in order with the
  caller's earlier UI changes. Source replacements and removed/replaced links expire the old capability.
- **Code controls retain their owners.** Native `codeBlockActions` supports `copy` and `wrap`. Adding `wrap`
  initially wraps the code; its selected state and native control survive further stream appends, including code
  inside containers. `renderCodeBlockAction` supplies app content and `labels` supplies table names/copy feedback.
  User Wrap and disclosure choices also survive root-cell recycling. The source lifecycle owns only those values;
  every mounted control creates its own signal. Replacing source identity, input, parser configuration or a
  non-prefix source clears the choices; changing a block or ancestor's logical kind clears that subtree's choices.
  Code and table scroll intent is reported as `onScrollIntent`.
- **Image rendering context.** `renderImage` receives `TextViewImageContext` (`image`, `linked`, `flow`,
  `lineHeight`). The app owns standalone image activation and loading; linked inline images use their enclosing
  Link, and linked block images use one native Link wrapper.

## Parts and their default styles

The defaults are a reading typography modeled on Allsum's documents (the constants and `Heading` at the end of
`view.rs`), its sizes in points: text 15 in 25.5 lines (1.7), blocks 11.25 apart (0.75 em); headings semibold, 27 /
20 / 17 / 15 with lines of 1.25 (level 1) or 1.35 and letter spacing of -0.02 em (level 1) or -0.012 em, with room
above them after a block (1.1 / 1.6 / 1.4 em, 0.6 em after a heading, none first: their top margin less the gap,
from `Before`, which the top level's rows keep as a memo); strong text semibold; links underlined 1 pt at 40 % of
their color, 3 pt below; `<mark>` on a rounded yellow (a marker's, `HIGHLIGHT`); code, keys and TeX at 13 in the
theme's `font-mono` (else the system's `monospace`) on a faint rounded
background (spans have no padding); lists indented 1.4 em, their markers (`•`, `◦`, `▪` by depth, or numbers) right-aligned against the content in
the indent (so `10.` reaches further left and the items stay in line), items 0.25 em apart, tasks a
15 pt box drawn as a view (filled with a `✓` when done, the item's text then muted and struck); quotes a 2 pt line at
their side (the text's color at 15 %, as rules), their text softer; alerts a tinted, bordered box (radius 8, padding 12 / 16) with a ring icon (`alertIcon`);
code blocks a bordered, rounded box (padding 14 / 16 on the code, inside its scroll view, 13 in 20.8 lines) with the app's actions floating over the
top right corner (no language label, no row kept for them); tables at 14 in lines of 1.55, cells padded 8 / 12 with 1 pt lines
(each cell its right and bottom ones, the grid the top and left ones), the header row on `muted` with
13 pt muted text; a rule 1 pt with 1.6 em above and below; images rounded 8; footnotes at 13, muted. Colors are
shadcn/ui's tokens of the theme (`nsh_base::theme()`: `foreground`, `muted-foreground`, `border`, `muted`, `primary`
for links and footnote references), read in bindings, so a theme or the appearance changes them natively; alerts
take GitHub's alert colors (note blue, tip green, important violet, warning amber, light and dark), a caution the
theme's `destructive`. Everything is the
app's to override: `classes` (Tailwind, applied after the part's own styles, so they win) and `styles` (inline, over
the classes), by part, and `class` / `style` on the root, whose text styles every part inherits (the root's defaults
are the text's size, line height and color). Content padding and spacing between root blocks use `contentStyle`,
the native list's typed content layout; nested containers retain their part styles. The root is also the part `root` (its `styles.root` is typed
`StyleProp<TextStyle>`, which the component's own `style`, a `ViewStyle`, is not). Line heights are points, not
multiples (typed styles have no multiple yet): an app that changes a part's size sets its line height too, as
Tailwind's `text-*` classes do. A node with several parts (`heading` then `heading2`; `blockquote`, `alert`, `alertNote`; `listMarker`,
`taskMarker`, `taskMarkerChecked`; `tableRow`, `tableHead`; `tableCell`, `tableHeaderCell`) gets their classes in that
order and their styles merged, later parts winning. The full list is `parts.rs`; a new part is one line of `parts!`.
Rust views also style parts with typed styles: `provide_context(TextViewParts::new().part(TextViewPart::Code, |s| ..))`
refines a part's `StyleRefinement` (theme colors stay adaptive) before the app's `classes` and `styles` apply.

## Syntax highlighting

Code blocks are highlighted by a `CodeHighlighter`: a function from a `CodeBlock` to `(Range<usize>, StyleRefinement)`
pairs, byte ranges in order; `TextView` turns them into spans of the code block's text, skipping ranges out of order,
overlapping or off a character boundary, and keeps its header, actions, scroll view and parts. Which one, first to
last: the app's `renderCodeBlock` (TS and Rust: the whole block is the app's), the app's `CodeHighlighter`
(`provide_context`, Rust: `tree-sitter`, a theme of its own, ...), the built-in one.

The built-in highlighter (`highlight.rs`, on the tokens, palette and syntaxes of `syntax.rs`, which the `Editor` shares; `nsh-base`'s feature `highlight`, on by default) is syntect 5 with pure-Rust
regexes (`regex-fancy`, so it builds for WebAssembly; no Oniguruma) and two-face's syntaxes (bat's set: syntect's own
plus TypeScript / TSX, TOML, Dockerfile, ...). A block's language is found by extension or name, case-insensitive
(`ts`, `tsx`, `rs`, `py`, `sh`, `yml`, `md`, `Rust`, ...) plus the other names fences use (`jsx`, `shell`, `golang`,
`c++`, `csharp`, `jsonc`, ...); no language, `text` or one syntect does not know leaves the block plain.

Colors: Allsum's reading palette (its `--hl-*` tokens, light and dark). TextMate scopes map to its kinds of token in code
(`token()`), not through syntect themes: one parse gives one range list whose colors are `AdaptiveColor`s, so both
appearances come from it and an appearance change re-highlights nothing; what maps to nothing keeps the code's own
color (the `codeBlockCode` part's).

| Token | Light / dark | Scopes |
|---|---|---|
| comment (italic) | `#6e7781` / `#7d7a72` | `comment` |
| keyword | `#8250df` / `#c4a7ff` | `keyword`, `storage`, operators that are words (`as`, `typeof`; symbols stay plain), declaring `storage.type` (`fn`, `let`, `class`), headings (`markup.heading`, `entity.name.section`) |
| string | `#116329` / `#9fd68a` | `string`, regular expressions, escapes, `markup.inserted` |
| number | `#953800` / `#f5b27a` | `constant` (numbers, literals such as `true` / `null`, other constants), `support.constant`, `variable.other.constant` |
| title | `#0550ae` / `#82b8ff` | `entity.name` (function and class names), `entity.other.inherited-class`, `support.function` / `.class`, `variable.function` |
| attr | `#7d4e00` / `#f0c674` | attribute names, parameters, `self` / `this` (`variable.language`), properties and members, object / mapping keys, YAML / TOML keys, shell variables |
| built | `#0a7285` / `#6fd3d8` | `support.function.builtin`, `support.macro` (`println!`), `support.type`, type `storage.type` (`f32`, `int`), `entity.name.tag` |
| deletion | `#cf222e` / `#f87171` | `markup.deleted` |

Markdown's `markup.bold` / `markup.italic` are bold / italic; everything else (punctuation, plain identifiers, operator
symbols) keeps the code's own color. The kinds and what they cover are Allsum's mapping of highlight.js's classes onto
its `--hl-*` tokens (allsum-io `web/src/tokens.css`, `web/src/docs/app.css`).

Some grammars give declarations and types one scope (Rust's `let`, `const` and `f32` are all `storage.type.rust`, `as`
is `keyword.operator.rust`): those settle by their text (`Token::settle`). The website's Shiki themes
(`website/src/light.theme.json` / `dark.theme.json`, `allsum-light` / `allsum-dark`) color the same scopes with the same
palette, so the site's code looks as an app's does. These colors are the one look NSH ships beyond `TextView`'s
typography and the `Editor`'s look, which colors its text with the same tokens (`crate::syntax`, `editor.md`); an app
with its own palette provides its own `CodeHighlighter`.

Cost (release, x86-64, 500 lines of real files): a fresh block takes 22 ms in Rust, 139 ms in TSX (TypeScript's
grammar is the heaviest), 2-3x that for the first block of a language, which compiles its regexes; loading the
syntaxes takes tens of milliseconds more. So the engine thread parses only what is cheap:

- The last 64 blocks are kept (one cache for the process, behind a mutex) with the parser's state at the start of their
  last line: a block shown again costs a few µs, and a block that grew (an AI reply streaming its code) is parsed only
  from its last line on (0.08-0.4 ms per line).
- Each syntax's speed (ns per byte) is measured as it parses; a fresh block, or what a block grew by, is parsed on the
  spot only when its expected cost is under 2 ms. A syntax not measured yet, or syntaxes not loaded yet, never are.
- Otherwise the code shows at once (plain, or with the colors of the part it starts with) and is highlighted on a
  blocking thread (`blocking`): the spans are a `dynamic` over a signal that the result sets, so only that text is
  made again, with the same characters (no layout moves). The syntaxes load on that thread too, with the first block
  that has a language. A block that goes away before its colors arrive leaves its tokens in the cache.
- WebAssembly has no threads: there the work is done after the frame that shows the block plain (`next_frame`), so
  the block appears at once but that later frame pays for the parsing.
- The web runtime gets the syntaxes from its page: `nsh-syntaxes.bin`, two-face's dump, next to `nsh.wasm` (the
  build that makes the module copies it from the two-face its workspace resolves, so it matches the module's syntect;
  `nsh package --target web` publishes it as `nsh-syntaxes.<digest>.bin` and names it in the page's `data`). The
  first block with a language asks for it (`syntax::load_async`, `nsh_core::runtime_data`), the page fetches it once
  and every block waiting is highlighted when it arrives. A page that cannot serve it keeps code plain (one warning).

`bench_highlight` (ignored: `cargo test --release -p nsh-base bench_highlight -- --ignored --nocapture`) prints these
numbers.

Size: the feature adds 1.2 MB to the web runtime (`--profile web`, 9.65 → 10.86 MB; brotli 2.31 → 3.17 MB) and
1.4 MB to a release `nsh-linux-host` (24.2 → 25.6 MB), mostly the syntaxes. `nsh-base`'s
default features have it; in this workspace the dependency is declared without them and the platforms
(`nsh-platform-*`, the GPUI backend's too) turn it on, so the CLI, the bundler, the engine and the headless test driver
build without syntect. Without the feature, code blocks the app does not highlight are plain.

## Extensions

- **Declared** (`MarkdownExtension`, a `JsObject`: TS apps and Rust alike) turn syntax into `CustomNode`s named by
  the extension, which the app shows with `renderCustom`. One of: `pattern` (a Rust `regex` matched in text outside
  code, links, keys, formulas and other custom nodes; the match is `text`, groups are attributes `"1"`, ... and by
  name; compiled once per thread, `common.rs`, cache bounded at 256 patterns, an invalid one warns once), `language`
  (fenced code of that language; the code is `text`, the rest of the info string `meta`), `tag` (HTML and MDX elements,
  any case; attributes, content parsed as blocks or inline content) or `container` (`:::name[label]{attrs}` …
  `:::`, as `remark-directive`).
- **Rust plugins** (`MarkdownPlugin`) read mdast nodes themselves: `configure` turns on markdown-rs constructs,
  `block` / `inline` read a node (the first plugin returning `Some` wins; `ParseContext` reads children as the parser
  does), `render` shows a custom node in Rust. A view provides them to every `TextView` below it with
  `provide_context(MarkdownPlugins::new().with(..))`. A plugin's `render` comes before `renderCustom`, which comes
  before the node's content.
- **`MarkdownOptions`**: `math`, `html`, `alerts` (default on), `frontmatter`, `mdx`, `streaming`, `preserveLineBreaks` (default off).
  With `mdx`, JSX elements are custom nodes named by their tag and `{expressions}` custom nodes `expression`; raw HTML
  is then text.

## Streaming

With `options.streaming`, `markdown/streaming.rs` repairs the last block of the text before parsing (the blocks before
it are complete; a text ending inside a fenced code or `$$` block needs nothing): emphasis, strong, strikethrough
(`**`, `*`, `__`, `_`, `~~`), inline code and formulas left open are closed in the reverse order they opened, a marker
with nothing after it yet is removed; `[text` and `[text](partial` show as their text, `![alt` and `![alt](partial`
are removed; an HTML tag being typed (`<di`, `<a href="x`) is removed; a table's header followed by the start of its
delimiter row is completed to a table (and a lone `-` under it is no heading). So a reply never flashes literal `**`
or `[` while the next chunk is on its way. The repair is a `Cow`: text with nothing open is parsed as it is.

## HTML

`html/` reads fragments and whole pages (their body) through html5ever, so unclosed and misplaced tags build the tree a
browser builds. It walks the tree in block or inline context (runs of inline content between blocks become
paragraphs), collapses whitespace as a browser does except in `<pre>`, skips what a reader does not show (`DROPPED`:
metadata, scripts, styles, form controls, embedded media; elements `hidden`, `aria-hidden="true"` or inline
`display: none`, such as KaTeX's HTML beside its MathML), and reads GitHub's own markup back (alerts, task list
checkboxes, `<math>` with a TeX annotation, `language-*` classes of code). Depth is bounded (256) and `colspan` too
(64): the input is untrusted.

## Accessibility

Headings have role `header`, links (and footnote references) role `link` with their title as the hint, task markers
role `checkbox` with their checked state, a disclosure's summary role `button` with its `expanded` state, images role
`image` with their alt text as the label. The texts are real texts, so screen readers read the document in order.

## Performance

- The worker parses the whole newest source, including late reference definitions; pending changes coalesce while
  one parse runs. There is no incremental AST or content cap. Matched workload measurements belong in
  `performance.md` once measured.
- Root rows are mounted near the surrounding viewport; each cell reads only its current block. Their keyed logical
  owners update only when that block's value changes. The complete parsed document remains available for static
  whole-document text, and the app's canonical raw-source copy remains independent of mounted rows.
- Selection joins the actual mounted texts. A single large root block (a long paragraph, code block, table or
  container), including the full literal shown before parsing, remains one row.
- A disclosure makes its content only while open.
- Images default to their natural size (one `image_size` read each), at most the width of the text.

## From gpui-kit

| gpui-kit | NSH |
|---|---|
| `TextView::markdown` / `::html` | `markdown` / `html` props; `document` for blocks the app builds |
| `TextViewStyle` (colors, code block style, heading sizes) | A default typography in the theme's colors; `classes` / `styles` by part; `TextViewParts` (typed, Rust) |
| Selection across the view | `selectable`: the view is a selectable view, one selection across its blocks (drag, double / triple click, Shift+click; long press and handles); a `selectable` `View` joins several views and texts |
| Code block actions (copy) | `codeBlockActions` (`copy` built in, the app's with `renderCodeBlockAction` / `onCodeBlockAction`) |
| Highlighter (tree-sitter) | Built in (syntect, Allsum's palette, feature `highlight`); the app's `CodeHighlighter` (Rust, styled ranges) or `renderCodeBlock` replaces it |
| Table actions | `renderTableActions` |
| `MarkdownPlugin` | `MarkdownPlugin` (Rust) and `MarkdownExtension` (declared, from TS too) |
| `image_source` / image loading | `renderImage`; the default loads the URL with the runtime's image loader |
| Link clicks | `onLinkPress({ url, target })` |
| Streaming fade / motion | The app's: the blocks are views it styles and animates (`nsh`, layout animation) |

## Limits

- Anchors are reported, not scrolled to: the app scrolls its `Scroll` to the heading it finds.
- A table column's floor is estimated from its text, not measured (Tables, above): inline images and custom nodes count for nothing.
- Spans take no padding: inline code and `<mark>` backgrounds hug their characters.
