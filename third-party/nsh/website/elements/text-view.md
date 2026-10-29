---
title: TextView
description: "The TextView component: Markdown, HTML or a document of blocks shown with native text and views, styled part by part, for AI chat replies, articles and help pages."
order: 26
group: base
demo: text-view
---

# TextView

`TextView` shows a document written in Markdown, in HTML or as blocks the app builds: headings, paragraphs, emphasis,
links, lists and task lists, quotes and GitHub's alerts, code, tables, images, formulas, footnotes and disclosures. It
is made for the replies of AI models in a chat: the reply streams in as Markdown, and each chunk shows the text with its
formatting in place. Parsing happens in Rust, and the document is drawn with [`Text`](./text.md) elements and views.
Root blocks are mounted near the surrounding scroll viewport. `contentStyle` sets their padding and spacing in
points; its default is `{ rowGap: 11.25 }`. Root classes and styles control outer geometry and text appearance.

It owns behavior and comes with a reading typography of its own: 15pt text in generous 25.5pt lines, semibold
headings with room above them, links underlined in the theme's `primary` color, code in the theme's `font-mono` in a bordered, rounded box, tables ruled on every side with a tinted header row, quotes with a line at their side and
alerts as tinted boxes with an icon in GitHub's alert colors. Its colors are the theme's tokens (`foreground`, `muted-foreground`, `border`,
`muted`, `primary`, and `destructive` for a caution), so a theme and the dark appearance reach
it. Each part takes the app's styles over these defaults: `classes` and `styles` in TSX, typed styles by part
(`TextViewParts`) in Rust. Rust makes one with `nsh_base::text_view()`, TSX with `<TextView>` from `nsh/base`.

```rust tabs
use nsh_base::{TextViewLinkPressEvent, text_view, theme};
use nsh_core::prelude::*;

const README: &str = "# Release notes

**Faster lists** and a new `TextView`:

- Markdown and HTML
- [x] Streaming replies
- [ ] Your own syntax

> [!TIP]
> Style every part with `TextViewParts`.";

fn release_notes() -> impl IntoElement {
    scroll().flex_1().child(
        text_view()
            .markdown(README)
            .on_link_press(|TextViewLinkPressEvent { url, .. }: &TextViewLinkPressEvent| log::info!("open {url}"))
            .p_5()
            .text_base()
            .text_color(theme().foreground),
    )
}
```

```tsx tabs
import { mount, Scroll } from "nsh";
import { TextView } from "nsh/base";

const README = `# Release notes

**Faster lists** and a new \`TextView\`:

- Markdown and HTML
- [x] Streaming replies
- [ ] Your own syntax

> [!TIP]
> Style every part with \`classes\`.`;

function App() {
  return (
    <Scroll class="flex-1" contentClass="p-5">
      <TextView
        markdown={README}
        class="text-base text-neutral-900 dark:text-neutral-100"
        classes={{
          heading1: "text-3xl",
          code: "rounded bg-neutral-100 dark:bg-neutral-800",
          link: "text-blue-600",
          alertTip: "border-l-4 border-green-600 pl-3",
        }}
        onLinkPress={({ url }) => console.log("open", url)}
      />
    </Scroll>
  );
}

mount(App);
```

In Rust, `text_view()` makes one as `view()` makes a view: a setter per prop (`.markdown(..)`, `.options(..)`,
`.selectable(..)`), a closure per render function (`.render_image(|image| ..)`), a listener per event
(`.on_link_press(..)`) and the typed style methods for its root (`.p_5()`, `.text_color(..)`), whose text styles pass
to every part.

## Built on Text

`TextView` is made of [`Text`](./text.md) elements, and its text behaves exactly as the Text page describes. Every
paragraph, heading, table cell and code block is one native `Text`: one block that lays out, wraps, follows the font
scale and, with `selectable`, selects and copies. Strong, emphasis, struck-through and the other inline marks
are its [spans](./text.md#spans); inline code is a span with a [span background](./text.md#span-backgrounds), so
`code: "rounded bg-neutral-100"` gives it a rounded background; links are
[pressable spans](./text.md#links); images and inline custom nodes are
[inline attachments](./text.md#inline-views-and-images). Text styles on the root pass to every part, as
[text styles](./text.md#text-styles) pass from a `Text` to its spans.

With `selectable`, mounted texts share one selection: a drag (or, on touch screens, a long press and the handles)
runs from one mounted paragraph, list item, cell or code block to the next, and Copy takes the selected text.
A `selectable` `TextView` is a [`View selectable`](./text-selection.md) of its own; inside a `View selectable`, its
selection also runs into the mounted texts and other `TextView`s around it. Whole-document copy uses the complete
source or `TextView.plainText(document)` ([The document model](#the-document-model)).

What `TextView` adds is the rest: reading Markdown, HTML or a document into blocks, the views around the texts (lists,
quotes, tables, code blocks, disclosures, footnotes), streaming, styles by part, render functions and extensions.

## The document

The content is one of three props, read in this order:

- **`markdown`**: CommonMark with GitHub's additions (tables, task lists, strikethrough, autolinks, footnotes, alerts),
  formulas (`$…$` and `$$…$$`) and HTML inside the Markdown.
- **`html`**: HTML as a reader shows it. Text, structure and inline formatting come through; scripts, styles, form
  controls and hidden elements stay out. A fragment or a whole page both work (a page shows its body).
- **`document`**: blocks the app builds or keeps: plain objects in TSX, `nsh_base::text_view::Document` in Rust
  ([The document model](#the-document-model)).

```rust tabs
use nsh_base::text_view;
use nsh_base::text_view::{Block, Document, Inline};
use nsh_core::prelude::*;

fn shipping() -> impl IntoElement {
    text_view().html(r#"<h2>Shipping</h2><p>Orders ship in <b>2 days</b>. <a href="/faq">FAQ</a></p>"#)
}

fn total() -> impl IntoElement {
    text_view().document(Document::new(vec![
        Block::Heading { level: 2, content: vec![Inline::text("Total")], anchor: None },
        Block::paragraph(vec![Inline::Strong { content: vec![Inline::text("$42.00")] }]),
    ]))
}
```

```tsx tabs
<TextView html={`<h2>Shipping</h2><p>Orders ship in <b>2 days</b>. <a href="/faq">FAQ</a></p>`} />

<TextView document={{
  blocks: [
    { type: "heading", level: 2, content: [{ type: "text", text: "Total" }] },
    { type: "paragraph", content: [{ type: "strong", content: [{ type: "text", text: "$42.00" }] }] },
  ],
}} />
```

`TextView` grows with its content. Put it in a [`Scroll`](./scroll.md) (or a row of a [`List`](./list.md)) for long
documents.

## Styling the parts

`class` and `style` set the native document viewport's outer geometry and text appearance; text styles set there
(color, size, font) pass to every part. `contentStyle` sets row padding and spacing with point values. The root is also the part `root`: `styles.root` takes text styles with their types (`style` is typed as a
view's), and `classes.root` classes. `classes` takes Tailwind classes by part and `styles` inline styles by part. A part's classes come after its own
default styles, so they win; its `styles` win over its classes. In Rust, the parts take typed styles: `TextViewParts`
gives each `TextViewPart` a function refining its style, for every `TextView` below the view that provides it
([Typed part styles](#typed-part-styles)), and the root takes the style methods. Line heights in the defaults are set in points: a
class that changes a part's size sets its line height too (Tailwind's `text-*` classes do).

```rust tabs
use nsh_base::{TextViewPart, TextViewParts, text_view, theme};
use nsh_core::prelude::*;

fn reply(markdown: Signal<SharedString>) -> impl IntoElement {
    provide_context(
        TextViewParts::new()
            .part(TextViewPart::Heading, |s| s.text_color(rgb(0x0a0a0a)))
            .part(TextViewPart::Heading2, |s| s.text_xl().mt_2())
            .part(TextViewPart::Blockquote, |s| {
                s.border_l(px(2.0)).border_color(rgb(0xd4d4d4)).pl_3().text_color(rgb(0x525252))
            })
            .part(TextViewPart::CodeBlock, |s| s.rounded_lg().bg(rgb(0xf5f5f5)))
            .part(TextViewPart::CodeBlockHeader, |s| s.px_3().pt_2())
            .part(TextViewPart::CodeBlockCode, |s| s.p_3().text_size(px(13.0)))
            .part(TextViewPart::Table, |s| s.rounded_lg().border_1().border_color(rgb(0xe5e5e5)))
            .part(TextViewPart::TableHead, |s| s.bg(rgb(0xfafafa)))
            .part(TextViewPart::TableCell, |s| {
                s.px_3().py_2().border_t_1().border_color(rgb(0xe5e5e5))
            })
            .part(TextViewPart::TaskMarkerChecked, |s| s.text_color(rgb(0x16a34a)))
            .part(TextViewPart::Link, |s| s.text_color(theme().primary)),
    );
    text_view()
        .markdown(move || markdown.get())
        .content_style(nsh_core::ListContentStyle {
            row_gap: px(12.0),
            ..nsh_core::ListContentStyle::default()
        })
        .text_size(px(15.0))
        .line_height(px(24.0))
        .text_color(rgb(0x262626))
        .font_family("Inter")
}
```

```tsx tabs
<TextView
  markdown={reply()}
  contentStyle={{ rowGap: 12 }}
  class="text-[15px] leading-6 text-neutral-800"
  classes={{
    heading: "text-neutral-950",
    heading2: "text-xl mt-2",
    blockquote: "border-l-2 border-neutral-300 pl-3 text-neutral-600",
    codeBlock: "rounded-lg bg-neutral-100",
    codeBlockHeader: "px-3 pt-2",
    codeBlockCode: "p-3 text-[13px]",
    table: "rounded-lg border border-neutral-200",
    tableHead: "bg-neutral-50",
    tableCell: "px-3 py-2 border-t border-neutral-200",
    taskMarkerChecked: "text-green-600",
  }}
  styles={{ root: { fontFamily: "Inter" }, link: { color: "#2563eb" } }}
/>
```

Some nodes are several parts, which apply in order: a level 2 heading is `heading` then `heading2`; an alert is
`blockquote`, `alert`, then its kind (`alertNote`, ...); a task marker is `listMarker`, `taskMarker`, then
`taskMarkerChecked` when done; the header row is `tableRow` then `tableHead`, and its cells `tableCell` then
`tableHeaderCell`.

| Part | Rust | What it is |
|---|---|---|
| `root` | `Root` | The native document viewport: outer geometry and inherited text appearance. Row padding and spacing use `contentStyle`. |
| `paragraph` | `Paragraph` | Every paragraph. |
| `heading` | `Heading` | Every heading, before its level's part. |
| `heading1` … `heading6` | `Heading1` … `Heading6` | Headings of that level (27, 20, 17, then 15pt, semibold). |
| `blockquote` | `Blockquote` | Quotations and alerts: a column of their blocks with a line at their side. |
| `alert` | `Alert` | Every alert (`> [!NOTE]`), after `blockquote`: a tinted box, a row of its icon and its blocks. |
| `alertNote`, `alertTip`, `alertImportant`, `alertWarning`, `alertCaution` | `AlertNote`, `AlertTip`, `AlertImportant`, `AlertWarning`, `AlertCaution` | Alerts of that kind. |
| `alertIcon` | `AlertIcon` | The icon of an alert: a ring with a glyph in the alert's color. |
| `list` | `List` | Every list: a column of its items. |
| `orderedList`, `unorderedList` | `OrderedList`, `UnorderedList` | Numbered and bulleted lists, after `list`. |
| `listItem` | `ListItem` | Every item: a row of its marker and its blocks. |
| `listMarker` | `ListMarker` | The marker of an item (`•`, `◦`, `▪` by depth, or `1.`), right-aligned in the indent before the item. |
| `taskMarker` | `TaskMarker` | The marker of a task item: a box drawn as a view, filled with a `✓` when done; after `listMarker`. |
| `taskMarkerChecked` | `TaskMarkerChecked` | The marker of a done task item, after `taskMarker`. |
| `listItemContent` | `ListItemContent` | The column of an item's blocks. |
| `codeBlock` | `CodeBlock` | Code blocks: a bordered, rounded box of the code, with the header over it. |
| `codeBlockHeader` | `CodeBlockHeader` | The row of a code block's actions (`codeBlockActions`), floating over its top right corner. |
| `codeBlockLanguage` | `CodeBlockLanguage` | The language a code block names (```` ```rust ````), at the start of its header; empty when it names none. |
| `codeBlockScroll` | `CodeBlockScroll` | The horizontal scroll view around a code block's code. |
| `codeBlockCode` | `CodeBlockCode` | The code of a code block (monospace, as written). |
| `code` | `Code` | Code in text (monospace, on a rounded background). |
| `keyboard` | `Keyboard` | Keys (`<kbd>`, as code). |
| `strong` | `Strong` | Strong text (semibold). |
| `emphasis` | `Emphasis` | Emphasized text (italic). |
| `strikethrough` | `Strikethrough` | Struck-through text. |
| `underline` | `Underline` | Underlined text (`<u>`, `<ins>`). |
| `highlight` | `Highlight` | Highlighted text (`<mark>`, on a rounded yellow). |
| `superscript`, `subscript` | `Superscript`, `Subscript` | Superscript and subscript (smaller). |
| `link` | `Link` | Links (in the theme's `primary` color, underlined). |
| `image` | `Image` | Images. |
| `math` | `Math` | Formulas in text, shown as their TeX in monospace when there is no `renderMath`. |
| `mathBlock` | `MathBlock` | Formula blocks, shown as their TeX in monospace when there is no `renderMath`. |
| `table` | `Table` | Tables: `renderTableActions`' content, then the scroll view of the cells. |
| `tableScroll` | `TableScroll` | The horizontal scroll view of a table's cells: columns fit their content when there is room, wrap down to a floor when the view is narrower, and past that the table scrolls. |
| `tableRow` | `TableRow` | Every row of a table: a view behind its cells, for backgrounds and borders (text styles go on `tableCell`). |
| `tableHead` | `TableHead` | The header row, after `tableRow`. |
| `tableCell` | `TableCell` | Every cell. |
| `tableHeaderCell` | `TableHeaderCell` | The header row's cells (smaller, muted), after `tableCell`. |
| `rule` | `Rule` | Thematic breaks: a line drawn as a top border. |
| `details` | `Details` | Disclosures (`<details>`). |
| `summary` | `Summary` | The summary of a disclosure; a press opens and closes it. |
| `summaryMarker` | `SummaryMarker` | The marker of a summary (`▸`, `▾`). |
| `footnotes` | `Footnotes` | The footnotes after the blocks: a column. |
| `footnote` | `Footnote` | A footnote: a row of its number and its blocks. |
| `footnoteLabel` | `FootnoteLabel` | The number of a footnote. |
| `footnoteReference` | `FootnoteReference` | A reference to a footnote in text (its number, smaller). |
| `custom` | `Custom` | Custom nodes shown as their content (when no render function shows them). |

## Streaming AI replies

Pass the reply as it grows, with `options={{ streaming: true }}` (`MarkdownOptions { streaming: true, .. }` in Rust). The end of a text that is still arriving often leaves
syntax open (`**bold`, `` `code ``, `[a link](htt`, a table whose header just arrived); streaming shows it as it will
look once closed, so the reader never sees stray `**` or `[`. Blocks are kept by position: the blocks that are complete
keep their views, and only the block being written is made again, so a long reply stays cheap to update.

`streamingCaret` follows the end of the document: inline at the end of the last text, wherever the last block ends (a
paragraph, a list item, a code block, a table's last cell), else on a line of its own after the last block (a rule,
content of a render function). Remove it when the reply is done.

```rust tabs
use nsh_base::{MarkdownOptions, text_view};
use nsh_core::prelude::*;

/// A reply the app appends to as chunks arrive, with `done` set at the end.
fn reply(text: Signal<SharedString>, done: Signal<bool>) -> impl IntoElement {
    text_view()
        .markdown(move || text.get())
        .options(move || MarkdownOptions { streaming: !done.get(), ..Default::default() })
        .streaming_caret(when(
            move || !done.get(),
            || view().ml_0p5().h_4().w_2().rounded_sm().bg(rgb(0xa3a3a3)),
        ))
}
```

```tsx tabs
import { signal, View } from "nsh";
import { TextView } from "nsh/base";

function Reply(props: { stream: AsyncIterable<string> }) {
  const text = signal("");
  const done = signal(false);
  (async () => {
    for await (const chunk of props.stream) text.update((t) => t + chunk);
    done.set(true);
  })();
  return (
    <TextView
      markdown={text()}
      options={{ streaming: !done() }}
      streamingCaret={done() ? undefined : <View class="ml-0.5 h-4 w-2 rounded-sm bg-neutral-400" />}
    />
  );
}
```

The caret is the app's own view, so it can blink or pulse with [`nsh`'s animation API](../modules/nsh.md#animation), and new
blocks can fade in with the app's animations.

## Links

Links are [pressable spans](./text.md#links). A press on one calls `onLinkPress` with `{ url }`; the app decides what it opens (a page of its own, a
[`WebView`](./web-view.md), a scroll to a heading). Headings have anchors (GitHub's: `## Getting started` is
`#getting-started`), so a link to `#getting-started` arrives as that string, and a footnote reference arrives as
`#footnote-<label>`.

```rust tabs
use nsh_base::{TextViewLinkPressEvent, text_view};
use nsh_core::prelude::*;

fn doc(markdown: &'static str) -> impl IntoElement {
    text_view().markdown(markdown).on_link_press(|TextViewLinkPressEvent { url, .. }: &TextViewLinkPressEvent| {
        match url.strip_prefix('#') {
            Some(anchor) => scroll_to_anchor(anchor),
            None => open_web(url),
        }
    })
}
```

```tsx tabs
<TextView
  markdown={doc}
  onLinkPress={({ url }) => {
    if (url.startsWith("#")) scrollToAnchor(url.slice(1));
    else nav.push({ name: "web", url });
  }}
/>
```

`scroll_to_anchor` and `open_web` (`scrollToAnchor` and `nav` in TSX) stand for the app's own functions.

With `links="open"`, a press on a link to another site or app (a URL with a scheme: `https:`, `mailto:`, ...) also
opens it outside the app with [`openUrl`](../modules/nsh.md#openurl), under the app's `openUrl` capability,
after `onLinkPress` reported it; anchors in the document (`#…`) are only reported. The default, `"report"`, opens
nothing.

```rust tabs
use nsh_base::{TextViewLinks, text_view};

text_view().markdown(doc).links(TextViewLinks::Open)
```

```tsx tabs
<TextView markdown={doc} links="open" />
```

## Render functions

Render functions put the app's own content into the document. Each one takes the value of a part and returns its content (JSX in TSX, an element in Rust); a
part keeps what was rendered for it while its value stays the same, so during streaming only the part being written is
rendered again.

| Prop | Rust | Value | Replaces or adds |
|---|---|---|---|
| `renderCodeBlock` | `.render_code_block(\|code\| ..)` | `TextViewCodeBlock` (`CodeBlock`) | Replaces a code block (syntax highlighting of your own). |
| `renderCodeBlockAction` | `.render_code_block_action(\|action\| ..)` | `TextViewCodeAction` | The icon of a code block action of the app's (`codeBlockActions`); the button around it is `TextView`'s. |
| `renderTableActions` | `.render_table_actions(\|table\| ..)` | `TextViewTable` (`Table`) | Adds content above a table (copy, export). |
| `renderMath` | `.render_math(\|math\| ..)` | `TextViewMath` | Replaces a formula: `{ tex, display }`, `display` for a `$$…$$` block. |
| `renderImage` | `.render_image(\|image\| ..)` | `TextViewImage` (`Image`) | Replaces an image (`{ src, alt, title }`): your own loading, sizing, a viewer on press. |
| `renderCustom` | `.render_custom(\|node\| ..)` | `TextViewCustomNode` (`CustomNode`) | Shows a custom node, by its `name` ([Markdown extensions](#markdown-extensions)). |

Code blocks carry actions over their top right corner, all drawn alike: ghost buttons whose background shows while
hovered or pressed, shown while a pointer is over the block on desktops and always on touch screens. `copy` is built
in: it copies the code and shows a check for a moment. Other actions are the app's: `renderCodeBlockAction` draws
their icon and `onCodeBlockAction` reports their presses (the built-in `copy` too, after it copied). `copy` writes the
clipboard as `Clipboard` does, so it needs the app's `clipboard` capability (`nsh.json`).

```rust tabs
use nsh_base::{TextViewCodeAction, TextViewCodeActionEvent, text_view};
use nsh_core::prelude::*;

fn reply(markdown: Signal<SharedString>) -> impl IntoElement {
    text_view()
        .markdown(move || markdown.get())
        .code_block_actions(vec![
            TextViewCodeAction::new("copy").with_label("Copy code"),
            TextViewCodeAction::new("run").with_label("Run"),
        ])
        .render_code_block_action(|_action: &TextViewCodeAction| text("▶").text_xs())
        .on_code_block_action(|event: &TextViewCodeActionEvent| {
            if event.id == "run" {
                run(&event.code.code);
            }
        })
}
```

```tsx tabs
import { Text } from "nsh";
import { TextView } from "nsh/base";

<TextView
  markdown={reply()}
  codeBlockActions={[
    { id: "copy", label: "Copy code" },
    { id: "run", label: "Run" },
  ]}
  renderCodeBlockAction={(action) => <Text class="text-xs">▶</Text>}
  onCodeBlockAction={({ id, code }) => id === "run" && run(code.code)}
/>
```

Code blocks are highlighted out of the box: for a language named on the fence (`ts`, `tsx`, `rust`, `python`, `bash`,
`json`, `toml`, `yaml`, `diff` and about two hundred more), the code shows in Allsum's code palette, light or dark with the
appearance; a block without a language shows plain. An app with highlighting of its own shows its code with
`renderCodeBlock`, from its own component or one of its Rust crate; a Rust view gives `TextView` its highlighter with
[`CodeHighlighter`](#syntax-highlighting). Here code with highlighting of the app's own, and an image that fills the
width:

```rust tabs
use nsh_base::text_view;
use nsh_base::text_view::{CodeBlock, Image};
use nsh_base::TextViewMath;
use nsh_core::prelude::*;

fn reply(markdown: Signal<SharedString>) -> impl IntoElement {
    text_view()
        .markdown(move || markdown.get())
        .render_code_block(|code: &CodeBlock| highlighted(code.language.clone(), code.code.clone()))
        .render_image(|img: &Image| {
            image(img.src.clone())
                .label(img.alt.clone())
                .aspect_ratio(16.0 / 9.0)
                .w_full()
                .rounded_lg()
        })
        .render_math(|math: &TextViewMath| math_view(math.tex.to_string(), math.display))
}
```

```tsx tabs
import { Image, View } from "nsh";

<TextView
  markdown={reply()}
  renderCodeBlock={(code) => <Highlighted language={code.language} code={code.code} />}
  renderImage={(image) => (
    <Image src={image.src} accessibilityLabel={image.alt} class="aspect-video w-full rounded-lg" />
  )}
  renderMath={(math) => <MathView tex={math.tex} display={math.display} />}
/>
```

`Highlighted` and `MathView` (`highlighted` and `math_view` in Rust) stand for the app's own components (a
highlighter, a formula renderer, or a component of its Rust crate). Without `renderMath` a formula shows as its TeX in monospace (`math` and `mathBlock` parts).

## Markdown extensions

`extensions` turns syntax of the app's into custom nodes, which `renderCustom` shows. Each extension has a `name`
(the `name` of the nodes it makes) and one of four kinds of syntax:

| Kind | Rust | Matches | The node |
|---|---|---|---|
| `pattern` | `MarkdownExtension::pattern(name, regex)` | A regular expression in text (Rust's `regex` syntax), outside code and links | Inline; `text` is the match, `attributes` its groups: `"1"`, `"2"`, … and named groups by name |
| `language` | `MarkdownExtension::language(name, language)` | Fenced code blocks of that language (```` ```chart ````) | A block; `text` is the code, `attributes.meta` the rest of the info string |
| `tag` | `MarkdownExtension::tag(name, tag)` | HTML or MDX elements of that tag, any case (`<Callout kind="tip">`) | Its attributes, its content parsed: `children` (blocks) for an element on its own lines, `content` (inline) inside text |
| `container` | `MarkdownExtension::container(name, container)` | Containers `:::name` … `:::` | A block of the Markdown inside (`children`); `:::note[Heads up]` gives `attributes.label`, `{key=value}` the other attributes |

````rust tabs
use nsh_base::text_view::{CustomNode, Document};
use nsh_base::{MarkdownExtension, text_view};
use nsh_core::prelude::*;

const MESSAGE: &str = r#"Thanks @ada! Here are the numbers:

```chart
12, 19, 7, 25
```

<Callout kind="tip">Charts update live.</Callout>

:::note[Heads up]
Numbers are in thousands.
:::"#;

fn custom(node: &CustomNode) -> AnyElement {
    match node.name.as_str() {
        "mention" => text(node.text.clone())
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(0x2563eb))
            .into_element(),
        "chart" => bar_chart(node.text.split(',').filter_map(|v| v.trim().parse().ok()).collect())
            .into_element(),
        "callout" => view()
            .rounded_lg()
            .bg(rgb(0xfffbeb))
            .p_3()
            .child(text_view().document(Document::new(node.children.clone())))
            .into_element(),
        _ => view()
            .gap_1()
            .border_l(px(4.0))
            .border_color(rgb(0x3b82f6))
            .pl_3()
            .child(
                text(node.attributes.get("label").cloned().unwrap_or_else(|| "Note".into()))
                    .font_weight(FontWeight::SEMIBOLD),
            )
            .child(text_view().document(Document::new(node.children.clone())))
            .into_element(),
    }
}

fn message() -> impl IntoElement {
    text_view()
        .markdown(MESSAGE)
        .extensions(vec![
            MarkdownExtension::pattern("mention", r"@(\w+)"),
            MarkdownExtension::language("chart", "chart"),
            MarkdownExtension::tag("callout", "callout"),
            MarkdownExtension::container("note", "note"),
        ])
        .render_custom(custom)
}
````

````tsx tabs
import { Text, View } from "nsh";
import { TextView } from "nsh/base";
import type { MarkdownExtension, TextViewCustomNode } from "nsh/base";

const extensions: MarkdownExtension[] = [
  { name: "mention", pattern: "@(\\w+)" },
  { name: "chart", language: "chart" },
  { name: "callout", tag: "callout" },
  { name: "note", container: "note" },
];

const message = `Thanks @ada! Here are the numbers:

\`\`\`chart
12, 19, 7, 25
\`\`\`

<Callout kind="tip">Charts update live.</Callout>

:::note[Heads up]
Numbers are in thousands.
:::`;

function Custom(props: { node: TextViewCustomNode }) {
  const node = props.node;
  switch (node.name) {
    case "mention":
      return <Text class="font-semibold text-blue-600">{node.text}</Text>;
    case "chart":
      return <BarChart values={node.text!.split(",").map(Number)} />;
    case "callout":
      return (
        <View class="rounded-lg bg-amber-50 p-3">
          <TextView document={{ blocks: node.children ?? [] }} />
        </View>
      );
    default:
      return (
        <View class="gap-1 border-l-4 border-blue-500 pl-3">
          <Text class="font-semibold">{node.attributes?.label ?? "Note"}</Text>
          <TextView document={{ blocks: node.children ?? [] }} />
        </View>
      );
  }
}

<TextView markdown={message} extensions={extensions} renderCustom={(node) => <Custom node={node} />} />;
````

`BarChart` (`bar_chart` in Rust) stands for the app's own chart. The mention pattern's group is in
`node.attributes?.["1"]` (`node.attributes["1"]` in Rust: `ada`) and the whole match in `node.text` (`@ada`). A custom node with no render function shows its content.

### Options

`options` picks the Markdown syntax read beyond CommonMark and GitHub's; in Rust it is a `MarkdownOptions` with the
same fields (`MarkdownOptions { streaming: true, ..Default::default() }`):

| Key | Type | Default | Description |
|---|---|---|---|
| `math` | `boolean` | `true` | Formulas: `$…$` in text, `$$…$$` blocks. |
| `html` | `boolean` | `true` | HTML inside the Markdown is read as the `html` prop reads it; `false` shows it as text. |
| `alerts` | `boolean` | `true` | GitHub's alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`. |
| `frontmatter` | `boolean` | `false` | YAML front matter (`---` … `---` first) becomes a custom node `frontmatter` whose `text` is the YAML. |
| `mdx` | `boolean` | `false` | MDX: JSX elements are custom nodes named by their tag, `{expressions}` custom nodes `expression`; raw HTML is then read as text. |
| `streaming` | `boolean` | `false` | The text is still arriving: syntax its end leaves open shows as if it were closed. |

## The document model

The `document` prop and the render functions' values are plain objects, each node tagged by its `type`. The types
come from `nsh/base`: `TextViewDocument`, `TextViewBlock`, `TextViewInline`, `TextViewCodeBlock`, `TextViewTable`,
`TextViewListItem`, `TextViewImage`, `TextViewFootnote`, `TextViewAlert` and `TextViewCustomNode`. In Rust they are
the types of `nsh_base::text_view` (`Document`, `Block`, `Inline`, `CodeBlock`, `Table`, `ListItem`, `Image`,
`Footnote`, `Alert`, `CustomNode`): `Block` and `Inline` are enums whose variants are the types below in PascalCase
(`Block::Heading { level, content, anchor }`, `Inline::Strong { content }`), with the same fields in snake case.

| Block `type` | Fields |
|---|---|
| `paragraph` | `content` |
| `heading` | `level` (1–6), `content`, `anchor?` |
| `blockquote` | `children`, `alert?` (`"note"`, `"tip"`, `"important"`, `"warning"`, `"caution"`) |
| `list` | `ordered?`, `start?`, `loose?`, `items` (`{ checked?, children }`) |
| `codeBlock` | `language?`, `meta?`, `code` |
| `math` | `tex` |
| `table` | `align?` (`"none"`, `"left"`, `"center"`, `"right"` per column), `head` (cells), `rows?` (rows of cells); a cell is `{ content }` |
| `rule` | |
| `details` | `open?`, `summary` (inline), `children` |
| `custom` | `name`, `attributes?`, `text?`, `data?`, `children?`, `content?` |

| Inline `type` | Fields |
|---|---|
| `text` | `text` |
| `strong`, `emphasis`, `strikethrough`, `underline`, `highlight`, `superscript`, `subscript` | `content` |
| `code` | `code` |
| `keyboard` | `text` |
| `link` | `url`, `title?`, `content` |
| `image` | `src`, `alt?`, `title?` |
| `math` | `tex` |
| `break` | |
| `footnoteReference` | `label`, `index` |
| `custom` | as the block |

A document also has `footnotes?`: `{ label, index, children }`, shown after the blocks in the order of their first
reference. An app can store replies as documents, build them from its own data, or mix in custom nodes that
`renderCustom` shows.

### Parsing and plain text

`TextView` also reads documents without showing them, synchronously:

| Function | Rust | Returns |
|---|---|---|
| `TextView.parse(markdown, options?, extensions?)` | `TextView::parse(markdown, options, extensions)` | The `TextViewDocument` the `markdown` prop would show. |
| `TextView.parseHtml(html, extensions?)` | `TextView::parse_html(html, extensions)` | The `TextViewDocument` the `html` prop would show. |
| `TextView.plainText(document)` | `TextView::plain_text(document)`, `Document::plain_text()` | The document's text without markup: blocks separated by blank lines, list items and table rows by line breaks, cells by tabs. |

A copy button for a whole reply:

```rust tabs
use nsh_base::{TextView, button};
use nsh_core::prelude::*;

fn copy_reply(reply: Signal<SharedString>) -> impl IntoElement {
    button()
        .on_press(move || {
            let document = TextView::parse(reply.get().to_string(), None, None);
            set_clipboard(TextView::plain_text(document));
        })
        .child(text("Copy"))
}
```

```tsx tabs
<Button onPress={() => Clipboard.writeText(TextView.plainText(TextView.parse(reply())))}>
  <Text>Copy</Text>
</Button>
```

An app can also parse once and keep the document (`document={doc}`), or change it before showing it.

## In Rust

Rust views use the same component from the `nsh-base` crate, with the examples above in their Rust tabs. Three things
are Rust's own: an app's highlighter, typed styles by part and Markdown plugins, each given to every `TextView` below
a view with `provide_context`. The document types are under `nsh_base::text_view`, where `Parser` also reads
documents with plugins (`Parser::new().plugin(..).markdown(source)`).

### Syntax highlighting

`TextView` highlights code with syntect in Allsum's code palette (`nsh-base`'s feature `highlight`, on by default);
a large block shows plain at once and takes its colors when a background thread has highlighted it.
`CodeHighlighter` is the app's highlighter in its place, given to every `TextView` below a view with `provide_context`.
It gets each code block and returns the styles of byte ranges of its code (in order, not overlapping; what they leave
out is plain); `TextView` shows the code as spans with those styles, inside its usual code block (header, actions,
scroll view, parts). The highlighter can be anything that turns code into styled ranges: `tree-sitter`, syntect with
a theme of the app's, ...

```rust
use std::ops::Range;

use nsh_base::{CodeHighlighter, text_view::CodeBlock};
use nsh_core::{element::StyleRefinement, prelude::*};

/// The app's highlighter (here with syntect, set up once by the app).
fn highlight(code: &CodeBlock) -> Vec<(Range<usize>, StyleRefinement)> {
    my_syntect::ranges(code.language.as_deref(), &code.code)
        .map(|(range, color, bold)| {
            let style = StyleRefinement::default().text_color(color);
            (range, if bold { style.font_weight(FontWeight::BOLD) } else { style })
        })
        .collect()
}

fn chat() -> impl IntoElement {
    provide_context(CodeHighlighter::new(highlight));
    view().child(messages())
}
```

`my_syntect::ranges` stands for the app's glue to its highlighter and `messages` for the app's view of the chat.
`renderCodeBlock`, when given, shows the code block in place of all of this.

### Typed part styles

`TextViewParts` styles parts with typed styles instead of class strings, for Rust views: each `TextViewPart` (one per
part of the [table above](#styling-the-parts)) gets a function refining its `StyleRefinement`. Given with
`provide_context`, they apply to every `TextView` below, before its `classes` and `styles`; theme colors read in them
follow the light and dark appearance.

```rust
use nsh_base::{TextViewPart, TextViewParts, theme};
use nsh_core::prelude::*;

fn chat_parts() {
    provide_context(
        TextViewParts::new()
            .part(TextViewPart::Heading1, |s| s.text_2xl().font_weight(FontWeight::BOLD))
            .part(TextViewPart::Code, |s| s.bg(theme().muted).rounded(px(4.0)))
            .part(TextViewPart::Link, |s| s.text_color(theme().primary)),
    );
}
```

### Markdown plugins

A `MarkdownPlugin` reads Markdown syntax in Rust: it gets each node of the syntax tree (markdown-rs's `mdast`) before
the parser reads it, and returns a block or inline content of its own, usually a `CustomNode`; it can also show the
custom nodes it makes. A view provides plugins to every `TextView` below it:

```rust
use nsh_base::text_view::{mdast, CustomNode, Inline, MarkdownPlugin, MarkdownPlugins, ParseContext};
use nsh_core::prelude::*;

struct Tickers;

impl MarkdownPlugin for Tickers {
    fn name(&self) -> &str {
        "tickers"
    }

    /// `$AAPL` in inline code becomes a ticker node.
    fn inline(&self, node: &mdast::Node, _cx: &mut ParseContext<'_>) -> Option<Inline> {
        let mdast::Node::InlineCode(code) = node else { return None };
        let symbol = code.value.strip_prefix('$')?;
        Some(Inline::Custom(CustomNode::new("ticker").with_text(symbol)))
    }

    fn render(&self, node: &CustomNode) -> Option<AnyElement> {
        (node.name == "ticker").then(|| text(node.text.clone()).font_weight(FontWeight::BOLD).into_element())
    }
}

fn chat() -> impl IntoElement {
    provide_context(MarkdownPlugins::new().with(Tickers));
    view().child(messages())
}
```

A plugin's `render` comes first, then `renderCustom`, then the node's content. `configure` turns on more of
markdown-rs's syntax, and `ParseContext` reads a node's children as the parser does.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `markdown` | `.markdown(..)` | `string` | | The document as Markdown. |
| `html` | `.html(..)` | `string` | | The document as HTML, when `markdown` is not given. |
| `document` | `.document(..)` | `TextViewDocument` | | The document as blocks, when neither `markdown` nor `html` is given. |
| `options` | `.options(..)` | `MarkdownOptions` | all defaults | The Markdown syntax read ([Options](#options)). |
| `extensions` | `.extensions(..)` | `MarkdownExtension[]` | `[]` | The app's syntax, as custom nodes ([Markdown extensions](#markdown-extensions)). |
| `classes` | `.classes(..)` | `TextViewClasses` | `{}` | Tailwind classes by part. |
| `styles` | `.styles(..)` | `TextViewStyles` | `{}` | Inline styles by part (each a `StyleProp<TextStyle>`), over the classes. |
| `contentStyle` | `.content_style(..)` | `ListContentStyle` | `{ rowGap: 11.25 }` | Padding and gaps of the native document rows, in points; a supplied value replaces the whole content layout. |
| `selectable` | `.selectable(..)` | `boolean` | `false` | Mounted document texts select together across paragraphs, headings, cells and code blocks ([Text selection](./text-selection.md)). |
| `links` | `.links(..)` | `"report" \| "open"` | `"report"` | What a press on a link does: reports it (`onLinkPress`), and with `"open"` also opens a link to another site or app outside the app ([Links](#links)). |
| `codeBlockScrollbar` | `.code_block_scrollbar(..)` | `boolean` | `true` | Code blocks show their horizontal scroll indicator. |
| `tableScrollbar` | `.table_scrollbar(..)` | `boolean` | `true` | Tables show their horizontal scroll indicator. |
| `streamingCaret` | `.streaming_caret(..)` | `JSX.Element` | | Shown at the end of the document: inline after the last text, else on its own line. |
| `renderCustom` | `.render_custom(\|node\| ..)` | `(node: TextViewCustomNode) => JSX.Element` | | Shows custom nodes. |
| `renderCodeBlock` | `.render_code_block(\|code\| ..)` | `(code: TextViewCodeBlock) => JSX.Element` | | Shows code blocks. |
| `codeBlockActions` | `.code_block_actions(..)` | `TextViewCodeAction[]` | `[]` | The actions over each code block's top right corner: `{ id: "copy" }` built in, others the app's. |
| `renderCodeBlockAction` | `.render_code_block_action(\|action\| ..)` | `(action: TextViewCodeAction) => JSX.Element` | | The icon of an action of the app's. |
| `renderTableActions` | `.render_table_actions(\|table\| ..)` | `(table: TextViewTable) => JSX.Element` | | Content above each table. |
| `renderMath` | `.render_math(\|math\| ..)` | `(math: TextViewMath) => JSX.Element` | | Shows formulas. |
| `renderImage` | `.render_image(\|image\| ..)` | `(image: TextViewImage) => JSX.Element` | | Shows images. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | | The native document viewport: outer geometry and text appearance (`styles.root` for typed text styles). Row padding and spacing use `contentStyle`. |

In Rust the classes and styles by part are `TextViewClasses` and `TextViewStyles`; a Rust view usually styles the
parts with [`TextViewParts`](#typed-part-styles).

## Events

| Event | Rust | Description |
|---|---|---|
| `onLinkPress` | `.on_link_press(\|event: &TextViewLinkPressEvent\| ..)` | A link was pressed: `{ url }`: its URL, `#anchor` for a heading, `#footnote-<label>` for a footnote. |
| `onCodeBlockAction` | `.on_code_block_action(\|event: &TextViewCodeActionEvent\| ..)` | A code block's action was pressed (after `copy` copied). |
| `onImagePress` | `.on_image_press(\|image: &Image\| ..)` | An image not in a link was pressed: `{ image }`, for the app to show it larger (a zoomable viewer of its own). |

## Accessibility

Screen readers read the document in order, text by text. `TextView` gives the structure its roles: headings are
headers, links are links (their title is the hint), task markers are checkboxes with their checked state, a
disclosure's summary is a button that says whether it is expanded, and images are read by their alt text.

## Related

- [Text](./text.md): the element every text of `TextView` is, with its spans, links, inline attachments and selection.
- [Text selection](./text-selection.md): one selection across several `TextView`s and texts.
- [`nsh/base`](../modules/nsh-base.md): the other base components.
- [Styling](../docs/styling.md) and [Tailwind](../docs/tailwind.md).
