---
title: RichEditor
description: nsh/base 的富文本编辑器：由应用的 schema 定义的文档、命令、插件、历史、键位、输入规则和 Markdown，按 ProseMirror 的架构构建，状态在 Rust 中。
order: 26.25
group: base
demo: el-rich-editor
---

# RichEditor

`RichEditor` 是按 ProseMirror 的架构构建的富文本编辑器。应用用 schema 定义文档由什么组成（段落、标题、列表、提及，以及它需要的任何节点和标记类型），编辑器让每个文档都符合它。修改是归入事务的步骤，所以它们可以撤销、映射位置，并以 JSON 传递；行为来自插件（历史、键位、输入规则、Markdown 快捷方式、应用自己的插件）；命令是工具栏运行和询问的值。编辑器的状态、命令和插件在 Rust 中运行：输入、键位绑定和输入规则从不等待 JS，应用在需要时以 JSON 读取状态。

一个编辑器有两部分：会话（`createRichEditor`），它拥有状态，由应用的代码驱动；视图（`<RichEditor editor={…} />`），它原生地渲染会话，并把平台的输入变成事务。多个视图可以显示同一个会话。

编辑器的内核是 Marijn Haverbeke 的 [ProseMirror](https://prosemirror.net) 的 Rust 移植，扩展层遵循 [Tiptap](https://tiptap.dev)：它们的数据结构、命令和名称都沿用下来，你对它们的了解在这里同样适用。两者都以 MIT 许可发布，移植自它们的部分适用其许可。

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

省略 `schema` 时编辑器使用起步 schema（`starterSchema()`）；省略 `plugins` 时它得到起步套件（`starterKit()`：起步的输入规则和键位绑定、基础键位绑定和历史）。空的 `plugins` 数组创建一个完全没有插件的编辑器。

## 样式

编辑器以应用的外观绘制文档：`classes` 和 `styles` 设置它的各个部件（`root`、`content`、`caret`、`selection`、`placeholder`、`composition`、`selectedNode`、`listMarker`，以及表格的 `selectedCell`、`tableGrip`、`tableResizeHandle`、`tableDropIndicator`），按类型设置节点（`nodes: { heading: "text-2xl font-bold", "heading[level=2]": "text-xl" }`），以及设置标记（`marks: { bold: "font-bold" }`）。节点规格把 `extra.listMarker` 设为 `"bullet"` 或 `"ordered"` 的列表（starter schema 的列表）中，每一项都在 `listMarker` 部件中显示标记：按层级显示 `•`、`◦`、`▪`，或从列表的 `start` 开始编号，放在列表项之前、列表的缩进中（如浏览器缩进 `ul`，在列表上设置 `pl-6`）。

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

`content` 部件是编辑器滚动视图中文档的盒子：它的内边距（`content: "px-6 py-5"`）就是文本周围的留白，滚动条贴着编辑器自己的边缘。拖动选择越过编辑器的上下边缘时，文档随之滚动，指针越远滚得越快。

### 气泡菜单

`bubbleMenu` 即 Tiptap 的气泡菜单：应用的内容显示在选区旁，默认在其上方（`bubbleMenuPlacement`，没有空间时翻到另一侧），相距 `bubbleMenuOffset` 点（8），位于一个随文本滚动的浮层中。应用在希望显示它时传入，依据会话的状态：

```tsx
const inLink = () => (revision(), editor.isActive("link"));

<RichEditor
  editor={editor}
  bubbleMenu={inLink() ? <LinkMenu href={editor.getAttributes("link").href} /> : undefined}
  bubbleMenuPlacement="bottom"
/>
```

链接菜单用 `chain([extendMarkRange("link"), command("setLink", { href })])` 编辑光标所在的链接，用同样的 `extendMarkRange` 之后的 `command("unsetLink")` 移除它。

## Schema

`defineSchema(spec)` 读取 ProseMirror 形式的 schema，并在出错时抛出错误说明哪里不对。节点类型声明它们的 `content`（内容表达式：`"inline*"`、`"paragraph+"`、`"(heading | paragraph) block*"`）、`group`、是否为 `inline` 或 `atom`、允许的 `marks`，以及带默认值和校验（`"string"`、`"number"`、`"boolean"`）的 `attrs`。第一个块类型是默认类型：回车创建的、填充必需内容的类型。spec 中其他的键作为类型的附加数据保留，供构建在编辑器之上的框架使用。

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

`RichSchema` 读写文档：`parse(content, format?)`（默认纯文本，也可以是 `"markdown"` 或 JSON）、`parseMarkdown(markdown)`、`serialize(doc, format?)`（默认 Markdown，也可以是 `"text"`、`"json"`）以及 `check(doc)`，它返回填好属性默认值的文档。`nodes`、`marks` 和 `topNode` 列出它的类型。Markdown 对应起步 schema 的名称（`paragraph`、`heading`、`blockquote`、`codeBlock`、`bulletList`、`orderedList`、`listItem`、`bold`、`italic`、`code`、`link`、`strike`）。

## 命令

命令是一个值：`toggleMark("bold")` 创建一个对象，应用可以保存它、绑定到按键、传给编辑器。`editor.run(command)` 运行它并返回是否生效；`editor.can(command)` 只询问而不做任何修改，工具栏用它决定按钮是否可用。`editor.isActive(name, attrs?)` 判断某个标记或节点在选区处是否生效（`isActive("heading", { level: 2 })`）。

| 命令 | 作用 |
| --- | --- |
| `toggleMark(name, attrs?)` | 给选区加上标记，已有时去掉；在光标处作用于接下来输入的文字 |
| `setMark(name, attrs?)` / `unsetMark(name)` | 加上或去掉标记 |
| `setBlockType(name, attrs?)` | 把选中的文本块变成某个类型（`setBlockType("heading", { level: 2 })`） |
| `wrapIn(name, attrs?)` / `lift()` | 用一个节点包裹选中的块（引用）/ 把它们提出父节点 |
| `wrapInList(name, attrs?)` | 用列表包裹选中的块 |
| `splitListItem(name)` / `sinkListItem(name)` / `liftListItem(name)` | 拆分、缩进或减少缩进列表项 |
| `undo()` / `redo()` | 撤销或重做修改（需要 `history()`） |
| `selectAll()`、`setTextSelection(anchor, head?)`、`setNodeSelection(pos)` | 选择 |
| `insertText(text)`、`insertContent(content, format?)` | 在选区处插入文字或内容 |
| `setNodeAttribute(pos, attr, value)` | 设置某位置节点的属性，作为一次可撤销的修改 |
| `command(name)` | 按名称取无参数的命令：`"splitBlock"`、`"joinBackward"`、`"exitCode"`、`"newlineInCode"`、`"selectParentNode"`…… |
| `chain(commands)` | 依次运行命令，合成一个事务（一个撤销步骤）；所有命令都生效时才生效 |
| `first(commands)` | 运行第一个生效的命令 |

```tsx
editor.run(chain([setBlockType("heading", { level: 1 }), toggleMark("bold")]));
const canIndent = editor.can(sinkListItem("listItem"));
```

## 会话

| 成员 | 含义 |
| --- | --- |
| `state`、`doc`、`selection` | 以 JSON 表示的状态、文档和选区，读取时生成 |
| `revision` | 状态已应用的事务数 |
| `isEmpty`、`undoDepth`、`redoDepth`、`composing` | 界面显示的编辑器信息 |
| `setContent(content, format?)` | 替换文档，作为一次可撤销的修改 |
| `insertContent(content, format?)` | 在选区处插入内容 |
| `getJSON()`、`getMarkdown()`、`getText()`、`textBetween(from?, to?, separator?)` | 某种格式的文档 |
| `dispatch(tr)` | 应用以 JSON 给出的事务（其步骤基于当前文档） |
| `subscribe(listener)` / `unsubscribe(id)` | 收到来自任何来源的每次修改，带新的 revision |
| `focus()`、`blur()` | 把键盘焦点移到显示编辑器的视图，或从中移开 |

位置的计算与 ProseMirror 相同：文本按 UTF-16 码元计数，叶子节点计为一，有内容的节点计其两个边界。需要在编辑后仍然有效的东西，在节点属性或标记中保存一个 id。

### 接管事务

`editor.dispatchTransaction = (tr) => { … }` 让应用自己提交每个事务：处理函数以 JSON 收到每个事务，用 `editor.applyTransaction(tr)` 提交，或者丢弃它。协作、日志和需要通过应用检查的事务会用到它；设为 `null` 把提交交还给编辑器。处理函数在 JS 的下一轮收到输入产生的事务，文档在它提交时改变。

## 扩展

扩展即 Tiptap 的扩展：每个扩展一并带来它的节点或标记类型、按键绑定、输入规则与粘贴规则、插件和具名命令；由扩展创建的编辑器从中得到 schema、键位、规则和命令表。内置扩展是与 Tiptap 同名的类，可直接使用，也可配置：

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

`StarterKit` 包含 `Document`、`Paragraph`、文本节点、`Heading`、`Blockquote`、`BulletList`、`OrderedList`、`ListItem`、`TaskList`、`TaskItem`、`CodeBlock`、`HardBreak`、`HorizontalRule`、`RichImage`（Tiptap 的 `Image`）、`Bold`、`Italic`、`Strike`、`Code`、`Underline`、`Link`、`Highlight`、`Subscript`、`Superscript`、`RichTextStyle`（Tiptap 的 `TextStyle`）、`TextAlign`、`History`、`TrailingNode`、`Typography` 和 `ListKeymap`。以某个扩展命名的选项设为 `false` 即不包含它，设为对象则配置它（`heading: { levels }`、`history: { depth }`、`textAlign: { types }`、`codeBlock: { enableTabIndentation }`）。每个类的 `configure(options)` 与 `extend({...})` 生成 `RichExtension`，它有 `name`、`type`、`priority` 和 `options`。每个编辑器还带有核心键位（Enter、Backspace、Delete、全选）。

每个扩展都加入 Tiptap 的命令，由 `command(name, args)` 运行：`toggleBold`、`setItalic`、`unsetStrike`、`toggleHeading({ level })`、`setParagraph`、`toggleBlockquote`、`toggleBulletList`、`toggleOrderedList`、`toggleTaskList`、`toggleCodeBlock({ language })`、`setHardBreak`、`setHorizontalRule`、`setImage({ src })`、`toggleHighlight({ color })`、`setTextAlign("center")`、`unsetTextAlign`，以及下文的链接、字数统计与建议命令。

列表切换作用于整个列表，如同文字处理软件的列表按钮：在项目符号列表中执行 `toggleOrderedList` 会把它的每一层（包括嵌套列表）都改为编号列表，而列表自身的切换会把选中的块从它们所在的每一层列表中移出。

`extensions` 中的顺序是同优先级扩展之间的次序：排在后面的扩展先处理按键；其余情况由 `priority`（默认 100）排序。使用 `extensions` 时，编辑器的 `plugins` 排在扩展的插件之后。

### 应用的扩展

`defineExtension` 创建扩展。它的函数在用它创建编辑器时以扩展的选项运行一次，返回数据：即上文工厂函数生成的命令、规则与插件。

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

`node` 或 `mark`（`defineSchema` 的写法）使它成为节点或标记扩展；`addGlobalAttributes` 为其他类型添加属性；`addProseMirrorPlugins` 返回插件，包括 `RichEditorPlugin`；`addPasteRules` 返回作用于粘贴文本的 `textRule` 与 `markRule` 规则。内置类的 `extend({...})` 替换所给的部分：`Underline.extend({ addKeyboardShortcuts: () => ({ "Mod-Alt-u": toggleMark("underline") }) })`。

应用的 crate 通过其 UI 集注册用 Rust 编写的扩展，JS 按名称取用：

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

`richExtension(name, options)` 也按名称找到每个内置扩展（`"text"`、`"bold"` 等）。

## 插件

| 工厂函数 | 添加的内容 |
| --- | --- |
| `history({ depth?, newGroupDelay? })` | 撤销历史；`newGroupDelay` 毫秒（500）内的修改一起撤销 |
| `keymap(bindings)` | 按键名绑定命令：`"Mod-b"`（Apple 平台上为 Cmd，其他平台为 Ctrl）、`"Shift-Enter"`、`"Alt-ArrowUp"` |
| `baseKeymap()` | 回车、退格、删除、全选和平台的文本编辑按键 |
| `starterKeymap()` | 起步 schema 的键位：标记、标题、列表、代码块、硬换行 |
| `inputRules(rules)` | 光标前输入的文字匹配某条规则时变成规则生成的内容；紧接着按退格撤销它 |
| `markdown(options?)` | 边输入边转换的 Markdown、Markdown 粘贴和 Markdown 复制（`blockRules`、`inlineRules`、`paste`、`copyAsMarkdown`） |
| `starterKit()` | 起步的输入规则和键位、基础键位和历史 |

插件在列表中的位置就是它的优先级：列表中靠前的键位和输入规则先处理按键或文字。输入规则来自 `markdownRules()`（标题、引用、列表、代码围栏、分隔线、常用标记）、`typographyRules()`（智能引号、省略号、破折号）、`textRule(match, replacement)`、`markRule(match, mark)`、`wrappingRule(match, node)` 和 `textblockRule(match, node)`。规则的 `match` 是以 `$` 结尾的正则表达式，与光标前的文字匹配。

### 应用的插件

`new RichEditorPlugin(key)` 创建一个行为由应用决定的插件，用链式调用设置：

```tsx
import { RichEditorPlugin, createRichEditor, starterKit } from "nsh/base";

const suggestions = new RichEditorPlugin("suggestions")
  .captureKeys(["ArrowUp", "ArrowDown", "Enter", "Escape"], (key) => moveSuggestion(key))
  .filterTransaction((tr) => tr.meta?.locked !== true)
  .appendTransaction((trs, state) => null);

const editor = createRichEditor({ plugins: [starterKit(), suggestions] });

// 建议列表打开时，这些按键归列表处理。
suggestions.capturing = true;
editor.setDecorations("suggestions", [{ from: 5, to: 9, kind: "inline", attrs: { class: "bg-accent" } }]);
```

- `captureKeys(keys, handler)`：`capturing` 为 true 时，编辑器消费这些按键，并随即告诉 `handler` 按下的是哪一个；键盘响应与没有插件时一样快。
- `editor.setDecorations(key, decorations)`：视图绘制在文档之上、不改变文档的行内属性、节点属性和小部件。它们随每次修改移动，直到再次设置。
- `filterTransaction(hook)` 和 `appendTransaction(hook)` 在应用自己的调用（`run`、`dispatch`、`setContent`……）中看到这些调用产生的事务：`filterTransaction` 可以丢弃一个事务，`appendTransaction` 可以返回一个与之一起应用的事务。`subscribe` 收到每次修改，包括输入。

## 链接、字数统计与建议

三个插件提供 Tiptap 的 Link、CharacterCount 和 Suggestion 行为，全部原生运行：

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

// 列表选中了某人：
editor.run(insertMention(editor.suggestion("mention")!.range, "u1", "Joan"));
```

- `link(options?)`：在 URL 后输入空格或 Enter 时，URL 变为链接，粘贴文本中的 URL 也一样（`autolink`）；在选区上粘贴 URL 会给选区加上链接（`linkOnPaste`）；按住 Mod 点按链接，或在编辑器只读时点按，会通过应用的 URL 处理打开它（`openOnClick`）；`enableClickSelection` 点按时选中整个链接。带协议和不带协议的 URL（`nsh.dev`、`https://nsh.dev/docs`、电子邮件地址）都能识别，不带协议的主机名使用 `defaultProtocol`（`http`）。链接接受 `http`、`https`、`ftp`、`ftps`、`mailto`、`tel`、`callto`、`sms`、`cid`、`xmpp` 以及 `protocols` 中的协议，因此 `setLink({ href })`、`toggleLink(attrs?)` 和自动链接会把脚本（`javascript:`）和 data URL 挡在外面。`unsetLink()` 移除选区所在的链接。
- `characterCount(options?)`：`editor.characters(mode?)` 统计文本的字符（`"textSize"`，与 JS 的 `length` 一样按 UTF-16 单元）或文档的位置数（`"nodeSize"`）；`editor.words()` 统计词数（Unicode 词边界）。设置 `limit` 后，会超出上限的修改被拒绝，粘贴的内容被截到放得下的长度；超出上限的初始文档会被截短（`autoTrim`）。`setCharacterLimit(limit)` 修改上限，`editor.characterLimit` 读取上限。
- `suggestion(options?)`：跟踪光标前输入的触发字符（`char`，默认 `@`）。`allowSpaces` 让查询可以包含空格，`allowedPrefixes` 列出触发字符前可以出现的字符（默认一个空格；`anyPrefix` 接受任何字符），`startOfLine` 要求触发字符位于行首（`/` 命令菜单）。`editor.suggestion(key)` 给出 `{ active, range, query, text, lastKey, keyCount }`；活动范围带有应用的 `decorationClass`（查询为空时还有 `decorationEmptyClass`）。建议活动期间，`captureKeys` 中的按键归应用的列表：编辑器接收它们并把最后一个记录在状态中；Escape 关闭建议（`exitSuggestion(key)` 也可以）。`replaceSuggestion(content, key?)` 用文本或 JSON 内容替换触发字符和查询。
- `withMention(schema, { name?, char? })` 添加 Tiptap 的提及节点：带 `id`、`label` 和触发字符的行内原子节点，在文本中写作 `@label`，在 HTML 中写作 `<span data-type="mention">`。`insertMention(range, id, label?)` 用一个提及和一个空格替换建议的范围。

弹出层属于应用：它读取建议的状态，放在 `coordsAtPos(range.from)` 处，并以自己的方式绘制条目。

## 表格

`TableKit` 提供 Tiptap 的表格：`RichTable`（Tiptap 的 `Table`）、`RichTableRow`、`RichTableHeader` 和 `RichTableCell`。它与 `StarterKit` 一起添加：

```tsx
import { RichEditor, StarterKit, TableKit, addRowAfter, createRichEditor, insertTable, mergeCells } from "nsh/base";

const editor = createRichEditor({
  extensions: [StarterKit, TableKit.configure({ table: { cellMinWidth: 40 } })],
});

editor.run(insertTable({ rows: 3, cols: 3, withHeaderRow: true }));
editor.run(addRowAfter());
```

表格接受选项 `resizable`（true）、`cellMinWidth`（25）、`lastColumnResizable`（true）、`allowTableNodeSelection`（false）和 `HTMLAttributes`；`TableKit.configure({ tableHeader: false })` 不包含其中一个扩展。单元格包含块，带有 `colspan`、`rowspan` 和 `colwidth`（其跨越的每一列的宽度，以点为单位）；行带有 `height`。

Tab 与 Shift-Tab 在单元格之间移动，在最后一个单元格按 Tab 会添加一行。在单元格边缘按方向键会进入相邻单元格；Shift 加方向键，或跨单元格拖动，会选中一个矩形区域的单元格（类型为 `"cell"` 的选区，其 `anchor` 与 `head` 是首尾单元格之前的位置）。Backspace 与 Delete 清空选中的单元格，选中全部单元格时删除整个表格。

在编辑器中，表格是由其单元格组成的网格：每列与其单元格的 `colwidth` 一样宽，没有宽度的列分享剩余空间（至少 `cellMinWidth` 宽），每行至少为其 `height` 高。默认外观来自主题：1 点 `border` 网格线，表头单元格使用 `muted` 背景，单元格带内边距，选中的单元格覆盖一层 `selectedCell` 部件，使用选区颜色。`classes.nodes`（`table`、`tableCell`、`tableHeader`）和这些部件可以重新设置全部外观。在单元格的第一行或最后一行按上下方向键，会进入上方或下方的单元格。

文档可编辑时：

- 在桌面平台上，每列的右边框和每行的下边框可以调整尺寸：指针显示调整光标和 `tableResizeHandle` 线条，表格随拖动变化，松开时在一步中设置 `colwidth` 或 `height`，撤销可以一次撤回。`resizable: false` 关闭此功能，`lastColumnResizable: false` 保持最后一列的宽度。
- 选区所在的表格在其上边框每列上方、左边框每行旁边显示抓手（`tableGrip`）。按下抓手选中该列或该行；在桌面平台上拖动抓手会显示放置位置（`tableDropIndicator`），松开时移动到那里。

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

这些命令都是 `nsh/base` 的辅助函数：

- `insertTable({ rows, cols, withHeaderRow })`（默认 3 × 3，带表头行）和 `deleteTable()`。
- `addColumnBefore()`、`addColumnAfter()`、`deleteColumn()`、`addRowBefore()`、`addRowAfter()`、`deleteRow()`。
- `mergeCells()`、`splitCell()` 和 `mergeOrSplit()`。
- `toggleHeaderRow()`、`toggleHeaderColumn()` 和 `toggleHeaderCell()`。
- `setCellAttribute(name, value)`、`setCellSelection({ anchorCell, headCell })`、`goToNextCell()`、`goToPreviousCell()` 和 `fixTables()`（修复缺少或重叠单元格的表格）。
- `moveTableRow({ from, to, select })` 与 `moveTableColumn({ from, to, select })` 移动一行或一列，连同其合并单元格跨越的行或列；`setColumnWidth({ col, width })` 与 `setRowHeight({ row, height })` 设置尺寸（`null` 表示随内容）。这些命令接受 `table`（表格之前的位置），以作用于选区所在表格之外的表格。

表格可读写 HTML（`<table>` 与 `<th>` / `<td>`、`colspan`、`rowspan` 和 `data-colwidth`）和 Markdown：带表头行且每个单元格只有一个段落的表格写成 GFM 管道表格，其他表格写成其 HTML，读回后保持不变。纯文本中，一行是用制表符分隔的单元格组成的一行文字。
