---
title: TextView
description: TextView 组件：用原生文本和视图显示 Markdown、HTML 或由文档块组成的文档，按部件设定样式，适用于 AI 聊天回复、文章和帮助页面。
order: 26
group: base
demo: text-view
---

# TextView

`TextView` 显示用 Markdown、HTML 或应用自己构建的文档块写成的文档：标题、段落、强调、链接、列表与任务列表、引用和 GitHub 的提示块（alert）、代码、表格、图片、公式、脚注和折叠块。它为 AI 模型在聊天中的回复而设计：回复以 Markdown 流式到达，每来一段，文本就带着格式显示出来。解析在 Rust 中完成，文档用 [`Text`](./text.md) 元素和视图绘制。

根文档块随外层滚动视口按需挂载。`contentStyle` 用点数设置文档行的内边距和间距，默认为 `{ rowGap: 11.25 }`；根节点的类和样式控制外层几何与文字外观。

它负责行为，并自带一套阅读排版：15pt 正文、宽松的 25.5pt 行高，半粗体标题且上方留有空间，链接以主题的 `primary` 色加下划线，代码使用主题的 `font-mono`，放在带边框的圆角框中，表格四边都有线、表头行带底色，引用在一侧带一条线，提示块是带图标、采用 GitHub 提示色的着色框。颜色取自主题的令牌（`foreground`、`muted-foreground`、`border`、`muted`、`primary`，警示（caution）用 `destructive`），因此主题和深色外观都会作用于它。每个部件在这些默认样式之上接收应用的样式：TSX 中是 `classes` 和 `styles`，Rust 中是按部件给出的类型化样式（`TextViewParts`）。Rust 用 `nsh_base::text_view()` 创建它，TSX 用从 `nsh/base` 导入的 `<TextView>`。

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

在 Rust 中，`text_view()` 像 `view()` 创建视图一样创建它：每个属性一个设置方法（`.markdown(..)`、`.options(..)`、`.selectable(..)`），每个渲染函数一个闭包（`.render_image(|image| ..)`），每个事件一个监听方法（`.on_link_press(..)`），根节点使用类型化的样式方法（`.p_5()`、`.text_color(..)`），其中的文本样式会传给每个部件。

<a id="built-on-text"></a>

## 基于 Text 构建

`TextView` 由 [`Text`](./text.md) 元素组成，其中的文本行为与 Text 页面描述的完全一致。每个段落、标题、表格单元格和代码块都是一个原生 `Text`：一个独立排版、换行、跟随字体缩放的文本块，设置 `selectable` 后可以选择和复制。加粗、强调、删除线等行内标记是它的[片段](./text.md#片段)；行内代码是带[片段背景](./text.md#片段背景)的片段，因此 `code: "rounded bg-neutral-100"` 会给它一个圆角背景；链接是[可点击的片段](./text.md#链接)；图片和行内自定义节点是[行内附件](./text.md#行内视图和图片)。根节点上的文本样式会传给每个部件，就像[文本样式](./text.md#文本样式)从 `Text` 传给它的片段一样。

设置 `selectable` 后，已挂载的文字共享一个选区：拖动（在触摸屏上是长按后拖动选择手柄）可以从一个已挂载的段落、列表项、单元格或代码块延伸到下一个，复制取得选中的文字。设置了 `selectable` 的 `TextView` 本身就是一个 [`View selectable`](./text-selection.md)；放在 `View selectable` 里时，它的选区还会延伸到周围已挂载的文字和其他 `TextView`。复制完整文档时使用完整源码或 `TextView.plainText(document)`（[文档模型](#the-document-model)）。

`TextView` 增加的是其余部分：把 Markdown、HTML 或文档读成文档块，文本周围的视图（列表、引用、表格、代码块、折叠块、脚注），流式输出，按部件设定样式，渲染函数和扩展。

<a id="the-document"></a>

## 文档内容

内容来自以下三个属性之一，按此顺序读取：

- **`markdown`**：CommonMark 加上 GitHub 的扩展（表格、任务列表、删除线、自动链接、脚注、提示块）、公式（`$…$` 和 `$$…$$`）以及 Markdown 中的 HTML。
- **`html`**：按阅读模式的方式显示 HTML。文本、结构和行内格式都会保留；脚本、样式、表单控件和隐藏元素不会显示。片段和完整页面都可以（完整页面显示其 body）。
- **`document`**：应用构建或保存的文档块：TSX 中是普通对象，Rust 中是 `nsh_base::text_view::Document`（[文档模型](#the-document-model)）。

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

`TextView` 随内容增高。长文档请放进 [`Scroll`](./scroll.md)（或 [`List`](./list.md) 的一行）中。

<a id="styling-the-parts"></a>

## 部件样式

`class` 和 `style` 设置原生文档视口的外层几何与文字外观；其中的文本样式（颜色、字号、字体）会传给每个部件。`contentStyle` 用点数设置文档行的内边距和间距。根节点也是部件 `root`：`styles.root` 以带类型的方式接收文本样式（`style` 的类型是视图样式），`classes.root` 接收类。`classes` 按部件接收 Tailwind 类，`styles` 按部件接收内联样式。部件的类排在它自己的默认样式之后，因此优先生效；它的 `styles` 又优先于它的类。在 Rust 中，部件接收类型化的样式：`TextViewParts` 为每个 `TextViewPart` 提供一个细化其样式的函数，作用于提供它的视图下面的每个 `TextView`（[类型化的部件样式](#typed-part-styles)），根节点则使用样式方法。默认样式的行高以点为单位：改变某个部件字号的类也要设定行高（Tailwind 的 `text-*` 类会一并设定）。

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

有些节点同时属于多个部件，按顺序应用：二级标题是 `heading` 再 `heading2`；提示块是 `blockquote`、`alert`，再是它的种类（`alertNote` 等）；任务标记是 `listMarker`、`taskMarker`，完成时再加 `taskMarkerChecked`；表头行是 `tableRow` 再 `tableHead`，表头单元格是 `tableCell` 再 `tableHeaderCell`。

| 部件 | Rust | 说明 |
|---|---|---|
| `root` | `Root` | 原生文档视口的外层几何与继承的文字外观；文档行的内边距和间距使用 `contentStyle`。 |
| `paragraph` | `Paragraph` | 每个段落。 |
| `heading` | `Heading` | 每个标题，在其级别的部件之前。 |
| `heading1` … `heading6` | `Heading1` … `Heading6` | 对应级别的标题（27、20、17，其余 15pt，半粗体）。 |
| `blockquote` | `Blockquote` | 引用和提示块：其文档块组成的一列，一侧带一条线。 |
| `alert` | `Alert` | 每个提示块（`> [!NOTE]`），在 `blockquote` 之后：着色的框，图标与其文档块组成的一行。 |
| `alertNote`、`alertTip`、`alertImportant`、`alertWarning`、`alertCaution` | `AlertNote`, `AlertTip`, `AlertImportant`, `AlertWarning`, `AlertCaution` | 对应种类的提示块。 |
| `alertIcon` | `AlertIcon` | 提示块的图标：以提示块颜色画出的圆环和其中的符号。 |
| `list` | `List` | 每个列表：其列表项组成的一列。 |
| `orderedList`、`unorderedList` | `OrderedList`, `UnorderedList` | 编号列表和项目符号列表，在 `list` 之后。 |
| `listItem` | `ListItem` | 每个列表项：标记与其文档块组成的一行。 |
| `listMarker` | `ListMarker` | 列表项的标记（按层级为 `•`、`◦`、`▪`，或 `1.`），在列表项之前的缩进中右对齐。 |
| `taskMarker` | `TaskMarker` | 任务项的标记：用视图画出的方框，完成时填色并显示 `✓`；在 `listMarker` 之后。 |
| `taskMarkerChecked` | `TaskMarkerChecked` | 已完成任务项的标记，在 `taskMarker` 之后。 |
| `listItemContent` | `ListItemContent` | 列表项的文档块组成的一列。 |
| `codeBlock` | `CodeBlock` | 代码块：带边框的圆角框，标题行浮在代码之上。 |
| `codeBlockHeader` | `CodeBlockHeader` | 代码块操作按钮（`codeBlockActions`）所在的行，浮在代码块右上角。 |
| `codeBlockScroll` | `CodeBlockScroll` | 包住代码块代码的水平滚动视图。 |
| `codeBlockCode` | `CodeBlockCode` | 代码块的代码（等宽，按原样）。 |
| `code` | `Code` | 文本中的代码（等宽，带圆角底色）。 |
| `keyboard` | `Keyboard` | 按键（`<kbd>`，与代码相同）。 |
| `strong` | `Strong` | 加重文本（半粗体）。 |
| `emphasis` | `Emphasis` | 强调文本（斜体）。 |
| `strikethrough` | `Strikethrough` | 删除线文本。 |
| `underline` | `Underline` | 下划线文本（`<u>`、`<ins>`）。 |
| `highlight` | `Highlight` | 高亮文本（`<mark>`，圆角黄色底）。 |
| `superscript`、`subscript` | `Superscript`, `Subscript` | 上标和下标（字号更小）。 |
| `link` | `Link` | 链接（主题的 `primary` 色，带下划线）。 |
| `image` | `Image` | 图片。 |
| `math` | `Math` | 文本中的公式；没有 `renderMath` 时以等宽字体显示其 TeX。 |
| `mathBlock` | `MathBlock` | 公式块；没有 `renderMath` 时以等宽字体显示其 TeX。 |
| `table` | `Table` | 表格：`renderTableActions` 的内容，然后是单元格的滚动视图。 |
| `tableScroll` | `TableScroll` | 表格单元格的横向滚动视图：空间足够时各列适应内容宽度，较窄时换行收缩到每列的下限，再窄则横向滚动。 |
| `tableRow` | `TableRow` | 表格的每一行：位于单元格后面的视图，用于背景和边框（文本样式设在 `tableCell` 上）。 |
| `tableHead` | `TableHead` | 表头行，在 `tableRow` 之后。 |
| `tableCell` | `TableCell` | 每个单元格。 |
| `tableHeaderCell` | `TableHeaderCell` | 表头行的单元格（字号较小，颜色淡），在 `tableCell` 之后。 |
| `rule` | `Rule` | 分隔线：用上边框画出的一条线。 |
| `details` | `Details` | 折叠块（`<details>`）。 |
| `summary` | `Summary` | 折叠块的摘要；点击它展开或收起。 |
| `summaryMarker` | `SummaryMarker` | 摘要的标记（`▸`、`▾`）。 |
| `footnotes` | `Footnotes` | 文档块之后的脚注：一列。 |
| `footnote` | `Footnote` | 一条脚注：编号与其文档块组成的一行。 |
| `footnoteLabel` | `FootnoteLabel` | 脚注的编号。 |
| `footnoteReference` | `FootnoteReference` | 文本中对脚注的引用（其编号，字号更小）。 |
| `custom` | `Custom` | 显示为其内容的自定义节点（没有渲染函数显示它们时）。 |

<a id="streaming-ai-replies"></a>

## 流式 AI 回复

随着回复增长传入它，并设置 `options={{ streaming: true }}`（Rust 中是 `MarkdownOptions { streaming: true, .. }`）。仍在到达的文本末尾常常留着未闭合的语法（`**bold`、`` `code ``、`[a link](htt`、刚到达表头的表格）；流式模式会把它显示成闭合后的样子，读者不会看到零散的 `**` 或 `[`。文档块按位置保留：已完成的块保留它们的视图，只有正在写的块会重新生成，因此长回复的更新依然很轻。

`streamingCaret` 跟随文档末尾：以行内方式显示在最后一段文本的末尾，无论最后一个块在哪里结束（段落、列表项、代码块、表格的最后一个单元格）；否则单独一行显示在最后一个块之后（分隔线、渲染函数的内容）。回复结束后去掉它。

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

光标是应用自己的视图，可以用 [`nsh` 的动画 API](../modules/nsh.md#animation) 让它闪烁或脉动，新的文档块也可以用应用自己的动画淡入。

<a id="links"></a>

## 链接

链接是[可点击的片段](./text.md#链接)。点击链接会以 `{ url }` 调用 `onLinkPress`；打开什么由应用决定（应用自己的页面、[`WebView`](./web-view.md)、滚动到某个标题）。标题带有锚点（GitHub 的规则：`## Getting started` 是 `#getting-started`），因此指向 `#getting-started` 的链接会以这个字符串到达，脚注引用则以 `#footnote-<label>` 到达。

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

`scroll_to_anchor` 和 `open_web`（TSX 中是 `scrollToAnchor` 和 `nav`）代表应用自己的函数。

设置 `links="open"` 后，按下指向其他网站或应用的链接（带 scheme 的 URL：`https:`、`mailto:` 等）时，在 `onLinkPress` 报告之后，还会用 [`openUrl`](../modules/nsh.md#openurl) 在应用之外打开它，受应用的 `openUrl` 能力约束；文档内的锚点（`#…`）只报告。默认值 `"report"` 什么都不打开。

```rust tabs
use nsh_base::{TextViewLinks, text_view};

text_view().markdown(doc).links(TextViewLinks::Open)
```

```tsx tabs
<TextView markdown={doc} links="open" />
```

<a id="render-functions"></a>

## 渲染函数

渲染函数把应用自己的内容放进文档。每个渲染函数接收一个部件的值并返回其内容（TSX 中是 JSX，Rust 中是元素）；只要值不变，部件就保留为它渲染的内容，因此流式输出时只有正在写的部件会重新渲染。

| 属性 | Rust | 值 | 替换或添加 |
|---|---|---|---|
| `renderCodeBlock` | `.render_code_block(\|code\| ..)` | `TextViewCodeBlock`（`CodeBlock`） | 替换代码块（应用自己的语法高亮）。 |
| `renderCodeBlockAction` | `.render_code_block_action(\|action\| ..)` | `TextViewCodeAction` | 应用自己的代码块操作（`codeBlockActions`）的图标；外面的按钮由 `TextView` 绘制。 |
| `renderTableActions` | `.render_table_actions(\|table\| ..)` | `TextViewTable`（`Table`） | 在表格上方添加内容（复制、导出）。 |
| `renderMath` | `.render_math(\|math\| ..)` | `TextViewMath` | 替换公式：`{ tex, display }`，`display` 表示 `$$…$$` 公式块。 |
| `renderImage` | `.render_image(\|image\| ..)` | `TextViewImage`（`Image`） | 替换图片（`{ src, alt, title }`）：自己的加载方式、尺寸、点击查看大图。 |
| `renderCustom` | `.render_custom(\|node\| ..)` | `TextViewCustomNode`（`CustomNode`） | 按 `name` 显示自定义节点（[Markdown 扩展](#markdown-extensions)）。 |

代码块的右上角浮动着操作按钮，外观统一：幽灵按钮，悬停或按下时显示背景；桌面上指针悬停在代码块上时显示，触摸屏上始终显示。`copy` 是内置的：复制代码，并短暂显示一个对勾。其他操作由应用定义：`renderCodeBlockAction` 绘制它们的图标，`onCodeBlockAction` 报告按下（内置的 `copy` 复制后也会报告）。`copy` 与 `Clipboard` 一样写入剪贴板，因此需要应用的 `clipboard` 权限（`nsh.json`）。

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

代码块开箱即有语法高亮：围栏上标明语言（`ts`、`tsx`、`rust`、`python`、`bash`、`json`、`toml`、`yaml`、`diff` 等约两百种）时，代码以 Allsum 的代码配色显示，随外观切换浅色或深色；未标明语言的代码块按原样显示。应用想用自己的高亮时，用 `renderCodeBlock` 显示代码，使用它自己的组件或它的 Rust crate 中的组件；Rust 视图通过 [`CodeHighlighter`](#syntax-highlighting) 把高亮器交给 `TextView`。下面用应用自己的高亮显示代码，并让图片占满宽度：

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

`Highlighted` 和 `MathView`（Rust 中是 `highlighted` 和 `math_view`）代表应用自己的组件（高亮器、公式渲染器，或应用 Rust crate 中的组件）。没有 `renderMath` 时，公式以等宽字体显示其 TeX（`math` 和 `mathBlock` 部件）。

<a id="markdown-extensions"></a>

## Markdown 扩展

`extensions` 把应用自己的语法变成自定义节点，由 `renderCustom` 显示。每个扩展有一个 `name`（它生成的节点的 `name`）和以下四种语法之一：

| 种类 | Rust | 匹配 | 生成的节点 |
|---|---|---|---|
| `pattern` | `MarkdownExtension::pattern(name, regex)` | 文本中的正则表达式（Rust 的 `regex` 语法），代码和链接之外 | 行内节点；`text` 是匹配的文本，`attributes` 是捕获组：`"1"`、`"2"`……以及按名字的命名捕获组 |
| `language` | `MarkdownExtension::language(name, language)` | 该语言的围栏代码块（```` ```chart ````） | 块节点；`text` 是代码，`attributes.meta` 是信息字符串的其余部分 |
| `tag` | `MarkdownExtension::tag(name, tag)` | 该标签的 HTML 或 MDX 元素，不区分大小写（`<Callout kind="tip">`） | 其属性，以及解析后的内容：独占一行的元素为 `children`（文档块），文本中的元素为 `content`（行内内容） |
| `container` | `MarkdownExtension::container(name, container)` | 容器 `:::name` … `:::` | 内部 Markdown 组成的块节点（`children`）；`:::note[Heads up]` 得到 `attributes.label`，`{key=value}` 得到其他属性 |

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

`BarChart`（Rust 中是 `bar_chart`）代表应用自己的图表。提及（mention）的捕获组在 `node.attributes?.["1"]`（Rust 中是 `node.attributes["1"]`：`ada`）中，完整匹配在 `node.text`（`@ada`）中。没有渲染函数的自定义节点显示其内容。

<a id="options"></a>

### 选项

`options` 选择在 CommonMark 和 GitHub 语法之外读取的 Markdown 语法；在 Rust 中它是字段相同的 `MarkdownOptions`（`MarkdownOptions { streaming: true, ..Default::default() }`）：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `math` | `boolean` | `true` | 公式：文本中的 `$…$`，`$$…$$` 公式块。 |
| `html` | `boolean` | `true` | Markdown 中的 HTML 按 `html` 属性的方式读取；`false` 时显示为文本。 |
| `alerts` | `boolean` | `true` | GitHub 的提示块：`> [!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`。 |
| `frontmatter` | `boolean` | `false` | 开头的 YAML front matter（`---` … `---`）成为名为 `frontmatter` 的自定义节点，其 `text` 是 YAML。 |
| `mdx` | `boolean` | `false` | MDX：JSX 元素成为以标签命名的自定义节点，`{expressions}` 成为名为 `expression` 的自定义节点；此时原始 HTML 按文本读取。 |
| `streaming` | `boolean` | `false` | 文本仍在到达：末尾未闭合的语法显示成闭合后的样子。 |

<a id="the-document-model"></a>

## 文档模型

`document` 属性和渲染函数收到的值都是普通对象，每个节点以 `type` 标明种类。类型从 `nsh/base` 导入：`TextViewDocument`、`TextViewBlock`、`TextViewInline`、`TextViewCodeBlock`、`TextViewTable`、`TextViewListItem`、`TextViewImage`、`TextViewFootnote`、`TextViewAlert` 和 `TextViewCustomNode`。在 Rust 中它们是 `nsh_base::text_view` 的类型（`Document`、`Block`、`Inline`、`CodeBlock`、`Table`、`ListItem`、`Image`、`Footnote`、`Alert`、`CustomNode`）：`Block` 和 `Inline` 是枚举，其变体是下表的类型改为 PascalCase（`Block::Heading { level, content, anchor }`、`Inline::Strong { content }`），字段相同，改为 snake case。

| 块 `type` | 字段 |
|---|---|
| `paragraph` | `content` |
| `heading` | `level`（1–6）、`content`、`anchor?` |
| `blockquote` | `children`、`alert?`（`"note"`、`"tip"`、`"important"`、`"warning"`、`"caution"`） |
| `list` | `ordered?`、`start?`、`loose?`、`items`（`{ checked?, children }`） |
| `codeBlock` | `language?`、`meta?`、`code` |
| `math` | `tex` |
| `table` | `align?`（每列 `"none"`、`"left"`、`"center"`、`"right"`）、`head`（单元格）、`rows?`（由单元格组成的行）；单元格是 `{ content }` |
| `rule` | |
| `details` | `open?`、`summary`（行内内容）、`children` |
| `custom` | `name`、`attributes?`、`text?`、`data?`、`children?`、`content?` |

| 行内 `type` | 字段 |
|---|---|
| `text` | `text` |
| `strong`、`emphasis`、`strikethrough`、`underline`、`highlight`、`superscript`、`subscript` | `content` |
| `code` | `code` |
| `keyboard` | `text` |
| `link` | `url`、`title?`、`content` |
| `image` | `src`、`alt?`、`title?` |
| `math` | `tex` |
| `break` | |
| `footnoteReference` | `label`、`index` |
| `custom` | 同块节点 |

文档还可以有 `footnotes?`：`{ label, index, children }`，按首次引用的顺序显示在文档块之后。应用可以把回复存成文档、用自己的数据构建文档，或者混入由 `renderCustom` 显示的自定义节点。

<a id="parsing-and-plain-text"></a>

### 解析与纯文本

`TextView` 也可以同步地读取文档而不显示它：

| 函数 | Rust | 返回 |
|---|---|---|
| `TextView.parse(markdown, options?, extensions?)` | `TextView::parse(markdown, options, extensions)` | `markdown` 属性会显示的 `TextViewDocument`。 |
| `TextView.parseHtml(html, extensions?)` | `TextView::parse_html(html, extensions)` | `html` 属性会显示的 `TextViewDocument`。 |
| `TextView.plainText(document)` | `TextView::plain_text(document)`、`Document::plain_text()` | 去掉标记的文档文本：文档块之间以空行分隔，列表项和表格行以换行分隔，单元格以制表符分隔。 |

复制整条回复的按钮：

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

应用也可以只解析一次并保存文档（`document={doc}`），或者在显示之前修改它。

<a id="in-rust"></a>

## 在 Rust 中使用

Rust 视图从 `nsh-base` crate 使用同一个组件，上面的示例都有对应的 Rust 标签页。有三样是 Rust 专有的：应用自己的高亮器、按部件给出的类型化样式和 Markdown 插件，都通过 `provide_context` 交给一个视图下面的每个 `TextView`。文档类型位于 `nsh_base::text_view` 下，那里的 `Parser` 还能带插件读取文档（`Parser::new().plugin(..).markdown(source)`）。

<a id="syntax-highlighting"></a>

### 语法高亮

`TextView` 用 syntect 以 Allsum 的代码配色高亮代码（`nsh-base` 的 feature `highlight`，默认开启）；较大的代码块先按原样显示，在后台线程高亮后再着色。`CodeHighlighter` 是代替它的应用自己的高亮器，通过 `provide_context` 交给一个视图下面的所有 `TextView`。它收到每个代码块，返回代码中各字节范围的样式（按顺序、互不重叠；未覆盖的部分保持原样）；`TextView` 以带这些样式的片段显示代码，仍放在它通常的代码块中（标题行、操作、滚动视图、部件）。高亮器可以是任何能把代码变成带样式范围的工具：`tree-sitter`、使用应用自己主题的 syntect 等。

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

`my_syntect::ranges` 代表应用与其高亮器之间的胶水代码，`messages` 代表应用的聊天视图。如果提供了 `renderCodeBlock`，它会代替以上这些显示代码块。

<a id="typed-part-styles"></a>

### 类型化的部件样式

`TextViewParts` 让 Rust 视图用类型化的样式代替类名字符串设定部件样式：每个 `TextViewPart`（对应[上面表格](#styling-the-parts)中的一个部件）得到一个细化其 `StyleRefinement` 的函数。通过 `provide_context` 提供后，它们作用于下面的每个 `TextView`，先于其 `classes` 和 `styles` 应用；其中读取的主题颜色会跟随浅色和深色外观。

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

<a id="markdown-plugins"></a>

### Markdown 插件

`MarkdownPlugin` 在 Rust 中读取 Markdown 语法：在解析器读取语法树（markdown-rs 的 `mdast`）的每个节点之前先交给它，它返回自己的文档块或行内内容，通常是一个 `CustomNode`；它也可以显示自己生成的自定义节点。一个视图为它下面的所有 `TextView` 提供插件：

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

插件的 `render` 最先生效，然后是 `renderCustom`，最后是节点的内容。`configure` 打开 markdown-rs 的更多语法，`ParseContext` 按解析器的方式读取节点的子节点。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `markdown` | `.markdown(..)` | `string` | | Markdown 形式的文档。 |
| `html` | `.html(..)` | `string` | | HTML 形式的文档，未提供 `markdown` 时使用。 |
| `document` | `.document(..)` | `TextViewDocument` | | 文档块形式的文档，`markdown` 和 `html` 都未提供时使用。 |
| `options` | `.options(..)` | `MarkdownOptions` | 全部默认值 | 读取的 Markdown 语法（[选项](#options)）。 |
| `extensions` | `.extensions(..)` | `MarkdownExtension[]` | `[]` | 应用自己的语法，生成自定义节点（[Markdown 扩展](#markdown-extensions)）。 |
| `classes` | `.classes(..)` | `TextViewClasses` | `{}` | 按部件设定的 Tailwind 类。 |
| `styles` | `.styles(..)` | `TextViewStyles` | `{}` | 按部件设定的内联样式（每个都是 `StyleProp<TextStyle>`），优先于类。 |
| `contentStyle` | `.content_style(..)` | `ListContentStyle` | `{ rowGap: 11.25 }` | 原生文档行的内边距和间距，单位为点；显式值替换整个内容布局。 |
| `selectable` | `.selectable(..)` | `boolean` | `false` | 已挂载的文字共享选区，可跨越段落、标题、单元格和代码块（[Text selection](./text-selection.md)）。 |
| `links` | `.links(..)` | `"report" \| "open"` | `"report"` | 按下链接时的行为：报告它（`onLinkPress`），设为 `"open"` 时还会在应用之外打开指向其他网站或应用的链接（[链接](#链接)）。 |
| `codeBlockScrollbar` | `.code_block_scrollbar(..)` | `boolean` | `true` | 代码块显示其水平滚动指示器。 |
| `tableScrollbar` | `.table_scrollbar(..)` | `boolean` | `true` | 表格显示其水平滚动指示器。 |
| `streamingCaret` | `.streaming_caret(..)` | `JSX.Element` | | 显示在文档末尾：在最后一段文本之后以行内方式显示，否则单独一行。 |
| `renderCustom` | `.render_custom(\|node\| ..)` | `(node: TextViewCustomNode) => JSX.Element` | | 显示自定义节点。 |
| `renderCodeBlock` | `.render_code_block(\|code\| ..)` | `(code: TextViewCodeBlock) => JSX.Element` | | 显示代码块。 |
| `codeBlockActions` | `.code_block_actions(..)` | `TextViewCodeAction[]` | `[]` | 每个代码块右上角的操作：`{ id: "copy" }` 内置，其余由应用定义。 |
| `renderCodeBlockAction` | `.render_code_block_action(\|action\| ..)` | `(action: TextViewCodeAction) => JSX.Element` | | 应用自己的操作的图标。 |
| `renderTableActions` | `.render_table_actions(\|table\| ..)` | `(table: TextViewTable) => JSX.Element` | | 每个表格上方的内容。 |
| `renderMath` | `.render_math(\|math\| ..)` | `(math: TextViewMath) => JSX.Element` | | 显示公式。 |
| `renderImage` | `.render_image(\|image\| ..)` | `(image: TextViewImage) => JSX.Element` | | 显示图片。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | | 原生文档视口的外层几何与文字外观（带类型的文本样式：`styles.root`）；文档行的内边距和间距使用 `contentStyle`。 |

在 Rust 中，按部件给出的类和样式是 `TextViewClasses` 和 `TextViewStyles`；Rust 视图通常用 [`TextViewParts`](#typed-part-styles) 设定部件样式。

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onLinkPress` | `.on_link_press(\|event: &TextViewLinkPressEvent\| ..)` | 链接被点击：`{ url }`，其 URL；标题为 `#anchor`，脚注为 `#footnote-<label>`。 |
| `onCodeBlockAction` | `.on_code_block_action(\|event: &TextViewCodeActionEvent\| ..)` | 代码块的操作被按下（`copy` 会在复制后报告）。 |
| `onImagePress` | `.on_image_press(\|image: &Image\| ..)` | 不在链接中的图片被点击：该图片，由应用放大显示（应用自己的可缩放查看器）。 |

<a id="accessibility"></a>

## 无障碍

读屏软件按顺序逐个文本朗读文档。`TextView` 为结构赋予角色：标题是标题（header），链接是链接（其 title 作为提示），任务标记是带勾选状态的复选框，折叠块的摘要是会说明是否展开的按钮，图片按其替代文本（alt）朗读。

<a id="related"></a>

## 相关内容

- [Text](./text.md)：`TextView` 中每段文本所用的元素，包括它的片段、链接、行内附件和选择。
- [文字选择](./text-selection.md)：跨越多个 `TextView` 和文字的同一个选区。
- [`nsh/base`](../modules/nsh-base.md)：其他基础组件。
- [样式](../docs/styling.md)与 [Tailwind](../docs/tailwind.md)。
