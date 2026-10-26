---
title: Editor
description: Editor 组件：代码编辑器，带语法高亮、行号、多光标、折叠、软换行、查找与替换、诊断和装饰，以及代码编辑器的按键。
order: 26.2
group: base
demo: el-editor
---

# Editor

`Editor` 是一个代码编辑器：五十多种语言的语法高亮、行号、多光标、折叠、软换行、查找与替换、诊断和装饰，以及代码编辑器的按键（移动和复制行、注释、缩进、输入时自动闭合的括号和引号）。它能打开任意长度的文件：只创建视野中的行，高亮随每次编辑逐行更新，所以长文件滚动和输入起来与短文件一样流畅。输入经由平台的输入系统，所以输入法（拼音、假名、死键）和软键盘在其中的表现与任何文本框相同。

编辑器负责行为，并带有一套由主题令牌构成的默认外观：主题的 `font-mono`，13pt 字号、20pt 行高，行号用 `muted-foreground`，有光标的行后面是一条淡淡的 `muted` 底色，选区是 `primary` 的浅色，缩进参考线用 `border`，语法颜色是内置的，与 [`TextView`](./text-view.md) 的代码块相同，分浅色和深色两套。每个部件都在这些默认值之上接受应用的样式（`classes` 和 `styles`）。Rust 用 `nsh_base::editor()` 创建它，TSX 用 `nsh/base` 中的 `<Editor>`。

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

编辑器填满应用给它的盒子（`flex-1`、一个高度），在其中滚动文本：纵向总是可以滚动；行比盒子长时可以横向滚动；开启 `softWrap` 后长行在编辑器的宽度处换行，不再横向滚动。

<a id="the-text"></a>

## 文本

- **受控**：传入 `value`，并在 `onChange` 中重新设置它，`onChange` 报告完整的新文本。应用修改的 `value`（加载了文件、格式化工具的输出）会作为一次可撤销的编辑替换文本，远离修改处的光标和折叠保持原位。
- **非受控**：传入 `defaultValue`，从 `onChange` 或 ref 的 `value()` 读取文本。

换行符是 `\n`：传入文本中的 `\r\n` 和 `\r` 都变成 `\n`。

<a id="languages"></a>

## 语言

`language` 用名称、别名、扩展名或文件名指定语言，不区分大小写：`"rust"`、`"rs"`、`"typescript"`、`"tsx"`、`"main.go"`、`"Dockerfile"`、`"Makefile"`。它决定高亮、`mod+/` 切换的注释、可匹配并参与缩进的括号、输入时自动闭合的符号对、组成单词的字符，以及默认的缩进：四个空格，Web 语言（JavaScript、TypeScript、JSON、HTML、CSS、YAML 等）两个空格，Go 和 Makefile 用制表符。`tabSize` 和 `hardTabs` 为所有语言设置缩进。其他名称都是纯文本，除非应用注册了它（[应用自己的语言](#your-own-languages)）。

支持的语言：Rust、JavaScript、JSX、TypeScript、TSX、JSON、Python、Go、C、C++、C#、Java、Kotlin、Swift、Objective-C、Objective-C++、Ruby、PHP、Lua、Shell、Fish、PowerShell、SQL、HTML、XML、Vue、Svelte、CSS、SCSS、Sass、Less、Markdown、YAML、TOML、INI、Dockerfile、Makefile、CMake、Dart、Scala、Elixir、Erlang、Haskell、OCaml、F#、Clojure、Zig、Perl、R、Julia、Nix、Terraform、Protocol Buffers、GraphQL 和 Diff。

```tsx
<Editor value={source()} onChange={(v) => source.set(v)} language={file().name} tabSize={2} softWrap class="flex-1" />
```

<a id="your-own-languages"></a>

### 应用自己的语言

Rust 代码可以让应用的编辑器认识更多语言，并用应用自己的高亮器（tree-sitter 语法、应用自己的解析器）高亮任何语言。`register_language` 注册一个 `EditorLanguage`：它的名称、别名、扩展名和文件名，以及编辑规则（注释、括号、输入时自动闭合的符号对、单词字符、缩进），`syntax` 指定用来高亮它的内置语法。`register_highlighter` 为一种语言（内置的或注册的）指定应用的高亮器：一个实现 `EditorHighlighter` 的类型，它收到每次编辑（行、字节和位置，与 tree-sitter 的编辑所需一致），在时间预算内、在 UI 线程之外给出每一行的记号（`EditorToken`，或经 `EditorToken::from_scope` 转换的 tree-sitter 捕获名或 TextMate 作用域）。编辑器保存这些记号，在编辑时让它们随文本移动，并为可见的行再次请求，与对内置高亮器的做法一样。`language` 先按名称、别名、扩展名或路径查找注册的语言，编辑器和差异视图都是如此。

每个引擎保存各自的语言。Rust 应用在挂载编辑器之前在根组件中注册；应用的 crate 在其 UI 集的 setup 中为 TSX 应用注册，运行该应用的每个引擎都会先调用它。

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

<a id="editing"></a>

## 编辑

编辑器的工作方式与代码编辑器相同：

- **多光标。** Alt 点击（Option 点击）添加一个光标，`mod+d` 选中选区的下一处出现，`mod+shift+l` 选中全部出现，添加光标的按键在上一行或下一行添加一个。输入、删除、移动和每个命令都在每个光标处执行；Escape 回到一个。`undoSelection`（`cmd+u`、`ctrl+u`）回到上一次移动之前的选区。
- **选区扩展。** `expandSelection`（`ctrl+shift+cmd+right`、`shift+alt+right`）按单位扩大选区：单词、字符串的内容和整个字符串、一对括号的内容和这对括号、整行、全文；`shrinkSelection` 按原路缩回。`splitSelectionIntoLines`（`shift+alt+i`）把跨多行的选区拆成每行一个选区。
- **缩进。** 新行保持当前行的缩进，在左括号（Python 的 `:`、Ruby 的 `do` 等）之后再加一级；在一对括号之间按 Enter，右括号单独放到下一行。Tab 和 Shift+Tab 缩进和反缩进所选的行；在行首空格中按 Backspace 回到上一个缩进位置。`autoIndent` 关闭这些行为。
- **括号和引号** 在输入时自动闭合，包住选区，再次输入闭合符号时跳过它（`autoClose`）。光标处的括号和与它配对的括号会加上边框。
- **撤销** 以一整段输入为单位：一个单词、一次删除、一个命令。移动或点击开始新的一步。
- **折叠。** 后面跟着缩进更深的行的那一行，可以用行号栏中的标记把这些行折叠起来：`⌄` 折叠，`›` 和行后的 `⋯` 展开。光标移入折叠处时，折叠会打开（[折叠](#folding)）。
- **点击。** 使用指针时，单击放置光标，双击选中一个单词，三击选中一行，Shift 点击扩展选区，拖动按点击所选的单位选择。Alt+Shift 拖动（Option+Shift；Linux 上也可用 Control+Alt）选择一个矩形块：每行一个选区，列的范围相同，在较短的行末尾之后也保持这些列。在触摸屏上，轻点放置光标，双击或长按选中手指下的单词，选区两端的手柄随手指拖动移动各自的一端（手柄周围的文本仍可用手指滚动）。
- **剪贴板。** 没有选区时复制和剪切取光标所在的整行，粘贴时这些行会作为整行插入到光标所在行的上方。

`readOnly` 保持文本不变，同时仍可选择、搜索和复制。

<a id="keys"></a>

## 按键

编辑器的按键在它拥有焦点时生效；其他输入框保留各自的按键。`mod` 在 macOS 和 iOS 上是 Command，在其他平台上是 Control（`keymap` 的按键写法）。

| 按键（macOS） | 按键（Windows、Linux） | 命令 |
|---|---|---|
| 方向键，加 Shift 选择 | 方向键，加 Shift 选择 | 按字符和行移动 |
| `alt+left` / `alt+right` | `ctrl+left` / `ctrl+right` | 按单词移动 |
| `cmd+left` / `cmd+right`、`home` / `end`、`ctrl+a` / `ctrl+e` | `home` / `end` | 行的第一个非空白字符（再按到行首）/ 行尾 |
| `cmd+up` / `cmd+down` | `ctrl+home` / `ctrl+end` | 文本的开头 / 结尾 |
| `pageup` / `pagedown` | `pageup` / `pagedown` | 上翻 / 下翻一页 |
| `alt+backspace` / `alt+delete` | `ctrl+backspace` / `ctrl+delete` | 向左 / 向右删除一个单词 |
| `cmd+backspace` / `cmd+delete`、`ctrl+k` | `ctrl+shift+backspace` / `ctrl+shift+delete` | 删除到行首 / 行尾 |
| `cmd+z` / `cmd+shift+z` | `ctrl+z` / `ctrl+shift+z`、`ctrl+y` | 撤销 / 重做 |
| `cmd+a` | `ctrl+a` | 全选 |
| `cmd+l` | `ctrl+l` | 选中整行（再按：连同下一行） |
| `cmd+d` | `ctrl+d` | 选中下一处出现 |
| `cmd+shift+l` | `ctrl+shift+l` | 选中每一处出现 |
| `cmd+alt+up` / `cmd+alt+down` | `ctrl+alt+up` / `ctrl+alt+down` | 在上方 / 下方添加光标 |
| `escape` | `escape` | 回到一个选区 |
| `alt+up` / `alt+down` | `alt+up` / `alt+down` | 把行上移 / 下移 |
| `alt+shift+up` / `alt+shift+down` | `alt+shift+up` / `alt+shift+down` | 向上 / 向下复制行 |
| `cmd+shift+k` | `ctrl+shift+k` | 删除行 |
| `cmd+enter` / `cmd+shift+enter` | `ctrl+enter` / `ctrl+shift+enter` | 在下方 / 上方新建一行 |
| `tab` / `shift+tab`、`cmd+]` / `cmd+[` | `tab` / `shift+tab`、`ctrl+]` / `ctrl+[` | 缩进 / 反缩进 |
| `cmd+/` | `ctrl+/` | 切换行注释 |
| `cmd+shift+\` | `ctrl+shift+\` | 跳到匹配的括号 |
| `ctrl+j` | `ctrl+j` | 合并行 |
| `ctrl+t` | | 交换光标两侧的字符 |
| `ctrl+alt+left` / `ctrl+alt+right`，加 Shift 选择 | | 按单词的一部分移动（camelCase、snake_case） |
| `shift+alt+a` | `shift+alt+a` | 切换块注释 |
| `shift+alt+i` | `shift+alt+i` | 把选区拆成每行一个 |
| `ctrl+shift+cmd+right` / `ctrl+shift+cmd+left` | `shift+alt+right` / `shift+alt+left` | 扩展 / 收缩选区 |
| `cmd+u` | `ctrl+u` | 回到之前的选区 |
| `cmd+g` / `cmd+shift+g`、`f3` / `shift+f3` | `f3` / `shift+f3` | 查找下一个 / 上一个匹配项 |
| `cmd+e` | | 查找选中的文本（`onFindWithSelection`） |
| `cmd+alt+[` / `cmd+alt+]` | `ctrl+shift+[` / `ctrl+shift+]` | 折叠 / 展开光标所在行 |
| `f12` | `f12` | 跳转到光标处的定义（`onDefinitionRequest`） |
| `cmd+.` | `ctrl+.` | 选区处的代码操作（`onCodeActionRequest`） |
| `cmd+c` / `cmd+x` / `cmd+v` | `ctrl+c` / `ctrl+x` / `ctrl+v` | 复制 / 剪切 / 粘贴 |

macOS 和 iOS 还有 Cocoa 的文本按键：`ctrl+b` / `ctrl+f` / `ctrl+p` / `ctrl+n` 移动，`ctrl+h` / `ctrl+d` 删除。

没有默认按键的命令和应用自己的命令，使用应用通过 [`keymap`](../modules/nsh.md#keymap) 绑定的按键，经由 ref 的 `run` 执行：

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

<a id="find-and-replace"></a>

## 查找与替换

`search` 是要查找的内容：`{ query, caseSensitive?, wholeWord?, regex?, inSelection? }`。它的匹配项会被高亮，选区所在的那一项更醒目，`onSearchChange` 报告 `{ count, current, error }`：匹配项的数量、选区所在的是哪一项（从 0 开始），以及正则表达式无效的原因。`findNext` 和 `findPrevious` 选中下一个和上一个匹配项，到头后绕回；`replace(text)` 替换当前匹配项并选中下一个，`replaceAll(text)` 把所有匹配项作为一次编辑替换，并返回替换的数量。正则表达式的替换文本用 `$1` 和 `${name}` 引用它的分组。

`inSelection` 只在它打开时选中的内容里查找（没有选中内容时为光标所在的行）：只要它保持打开，这个范围就一直保留，随编辑移动，选区从一个匹配项移到另一个时也不变。`findWithSelection`（macOS 上为 `cmd+e`）用 `onFindWithSelection` 报告选中的文本或光标处的单词，供查找栏作为查询内容。

查找栏由应用自己实现：

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

<a id="diagnostics"></a>

## 诊断

`diagnostics` 标记语言服务器或 linter 报告的问题：在每个范围的文字下方画一条细波浪线，颜色由严重程度决定（`error`、`warning`、`info`、`hint`）。位置是从 0 开始的行和 UTF-16 列，与语言服务器相同，所以它的诊断可以原样传入。用户输入时这些标记留在它们的文本上，直到应用传入新的诊断；消息的显示（一个列表、行旁的悬浮卡片）由应用负责。

诊断也带着语言服务器 `Diagnostic` 的其余字段。它的 `tags` 按语言客户端的方式绘制文本：`unnecessary` 的代码（未使用的变量、不可达的代码）淡化显示，`deprecated` 的代码加删除线，分别使用 `unnecessaryText` 和 `deprecatedText` 部件；带标签的提示只体现在它的文本上。`codeDescription.href` 是描述其代码的页面（一条 lint 规则的页面），`relatedInformation` 列出与它相关的其他位置（`{ location: { uri?, range }, message }`）：悬停把两者交给应用，由应用在悬浮卡片中显示并打开页面。语言服务器以数字（`1`、`2`）发送标签，编辑器接收它们的名称。

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

<a id="decorations"></a>

## 装饰

`decorations` 为应用选择的范围设置样式：来自语言服务器的语义高亮、正在执行的语句、评审中改动的行。装饰的 `class` 和 `style` 设置其文本的样式；`lineClass` 和 `lineStyle` 设置其所在各行的样式，位于文本后面。与诊断一样，它们在编辑中留在自己的文本上，直到应用设置新的装饰。

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

<a id="your-own-highlighting"></a>

### 应用自己的高亮

装饰的 `token` 按内置高亮给这类记号的颜色给其文本着色（`comment`、`keyword`、`string`、`number`、`title`、`attr`、`built`、`deletion`），取代内置高亮器在那里找到的记号：应用自己的高亮器（语言服务器的语义记号、应用自己的解析器）把它的记号映射到这些种类上，就得到编辑器在浅色和深色下的颜色。最内层装饰的记号优先；`class` 和 `style` 作用在它之上。`highlighting={false}` 关闭内置高亮器，文本只由应用的记号着色，而 `language` 仍然决定注释、括号和缩进。

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

<a id="folding"></a>

## 折叠

折叠从缩进比上一行更深的行开始。`foldRanges` 改用应用自己的范围（`{ startLine, endLine }`，即语言服务器折叠范围的形状，可以原样传入）：第 `startLine` 行显示折叠，其后直到 `endLine` 的行被折叠起来。它们在编辑中留在自己的行上，直到应用传入新的范围。

折叠可以嵌套：折叠一个块时，块内的折叠保持折叠，所以展开这个块时它们仍是原来的样子。`foldRecursive` 折叠一个块和其中的每个块，`unfoldRecursive` 把它们全部展开，`foldLevel(n)` 折叠嵌套层级为 `n` 的每个块，`foldSelection`（或 `foldRange(range)`）折叠任意的行，不论折叠从哪里开始。`onFoldChange` 在每次改变后报告已折叠的范围，`folds()` / `setFolds(ranges)` 读取并恢复它们，以便与文件一起保存。

```tsx
const ranges = signal<EditorFoldRange[]>([]);
const folded = new Map<string, EditorFoldRange[]>();

<Editor
  ref={editor}
  value={file().text}
  language={file().name}
  foldRanges={ranges()} // 来自语言服务器的 textDocument/foldingRange
  onFoldChange={(folds) => folded.set(file().name, folds)}
  class="flex-1"
/>
<Button onPress={() => editor.foldLevel(2)}><Text>折叠方法</Text></Button>
```

<a id="breakpoints-and-context-menus"></a>

## 断点和上下文菜单

点击行号会报告 `onLineNumberPress(line)`，可以在这里设置断点，由应用画成一个装饰。辅助按键（右键单击、Mac 上的 Control 点击）报告 `onContextMenu({ position, x, y })`：指针下文本中的位置和根视图中的坐标，应用在那里打开自己的菜单。在触摸屏上，长按、双击、松开手柄和轻点选区也会报告它，并带有 `selection`：选区在根视图中的范围（`{ x, y, width, height }`），`x` / `y` 是它顶边的中点，用来放置编辑菜单。

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

<a id="language-features"></a>

## 语言功能

建议、悬停信息、跳转到定义和代码操作来自应用的语言服务器。补全列表、行内补全和定义链接由编辑器自己绘制，并带有它们的按键；其余的，编辑器告诉应用时机和位置，由应用画出自己的弹出层（锚定到 `pageBounds` 的 [`Overlay`](./overlay.md)）。

### 补全

设置 `completion` 后，编辑器向应用请求建议，并把它们显示为正在输入的单词下方的列表（靠近窗口底部时显示在上方）：

- 在单词末尾输入字母、数字或 `_` 时，以 `onCompletionRequest(event)` 请求，触发方式为 `"typing"`：`event` 包含它的 `id`、光标的 `offset` 和 `position`、`query`（目前输入的单词）以及查询开始处的偏移 `queryStart`。`completionTriggerCharacters` 中的每一项（`["."]`、`["::", "<"]`）在输入后以空查询请求，触发方式为 `"character"`（并带有 `character`）；`showCompletions()` 或 `run("showCompletions")` 在光标处请求，触发方式为 `"invoked"`。
- 应用以 `presentCompletions(event.id, items)` 回应。每一项是语言服务器 `CompletionItem` 的形状：`label`，以及可选的 `kind`（`"function"`、`"variable"`、`"class"`……）、`detail`、`documentation`、`insertText`、`filterText`、`sortText` 和 `range`。显示的是对最新请求的回应；更早的回应，或光标已离开的单词的回应，会被搁置。
- 继续输入时列表就地过滤：查询按顺序、不区分大小写地匹配每一项的 `filterText`（否则是它的标签），以查询开头的项在前，其次是最紧凑的匹配，再按 `sortText` 排序。匹配的字母会突出显示。传入 `incomplete: true`（`presentCompletions(id, items, true)`）时，编辑器随着继续输入再次请求。
- 上下方向键（以及 Control+P / Control+N）在列表中移动，Page Up 和 Page Down 按页移动，Enter 和 Tab 接受，Escape 关闭。指针标记一项，点击（触摸屏上轻点）接受它。选中项的 `documentation` 显示在列表旁边。
- 接受时，用该项的 `insertText`（否则是它的标签）替换它的 `range`（否则是查询），作为撤销一次撤回的一步，在光标处以及前面文本相同的其他每个光标处进行，并报告 `onCompletionAccept({ item })`。
- 光标离开单词、输入空格或其他标点、编辑器失去焦点，以及光标滚出视野时，列表关闭。

在没有列表显示时停止输入一段时间（`inlineCompletionDelay`，默认 300 毫秒），会请求行内补全：`onInlineCompletionRequest({ id, offset, position })`。`presentInlineCompletion(id, text)` 以淡色在光标处显示 `text`，Tab 插入它，Escape、编辑或移动清除它。

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

### 悬停与点击

- `onHover(event)`：鼠标停在一个字符上（桌面和 Web）。`event` 包含它的 `position`、UTF-16 的 `offset`、所在单词的 `range`、指针的 `pagePosition`、单词的 `pageBounds`、按住的 `modifiers`，以及那里的 `diagnostics`，应用显示它们的消息。移到另一个单词时立即报告下一次悬停。
- `onHoverEnd()`：鼠标离开了单词或编辑器，或者它下面的文本改变或滚动了。
- `onTextPress(event)`：一个字符被点击，在编辑器放好光标之后：`{ position, offset, range, pagePosition, modifiers, clicks }`。
- `caretBounds()` 和 `rangeBounds(range)`：光标和一个范围的位置 `{ bounds, pageBounds }`（在编辑器中和在根视图中）：应用的弹出层在那里打开。

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

<a id="go-to-definition-and-code-actions"></a>

### 跳转到定义与代码操作

按住 Mod（macOS 和 iOS 上是 Command，其他平台是 Control）时，鼠标下的单词变成链接，与代码编辑器一样：

- 在单词上按住 Mod（鼠标停在那里时按下，或按住时把鼠标移到那里），编辑器以 `onDefinitionRequest(event)` 请求，触发方式 `"hover"`：`event` 包含它的 `id`、字符的 `position` 和 `offset`，以及单词的 `range`。语言服务器找到定义时，以 `presentDefinitionLink(event.id, range)` 回应：这个范围加上下划线（`definitionLink` 部件），指针在它上面变成手形。松开 Mod、鼠标离开它、文本改变或滚动，或者调用 `hideDefinitionLink()` 时，链接消失。显示的是对最新请求的回应；更早的回应会被搁置。
- 在单词上 Mod 点击，以触发方式 `"press"` 请求；在链接上点击时光标保持原位。F12（`goToDefinition`，`run("goToDefinition")`）请求光标处的单词，触发方式 `"key"`。由应用跳转到定义：同一文本中的定义用 `revealPosition` 和 `setSelections`，另一个文件中的用它自己的导航。
- Mod+.（`showCodeActions`，`run("showCodeActions")`）报告 `onCodeActionRequest({ range, position, bounds })`：主选区（起点在前）、光标和它的方框。应用向语言服务器请求操作，在 `bounds.pageBounds` 处显示自己的菜单（[`Menu`](./menu.md) 或 `Overlay`），再用 `edit(edits)` 应用所选操作的编辑。

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

<a id="size-and-scrolling"></a>

## 尺寸与滚动

设置 `minRows` 和 / 或 `maxRows` 时，编辑器随文本增高：它和文本的行一样高，至少 `minRows` 行，到 `maxRows` 行起文本滚动，就像消息输入框或笔记本的单元格。否则由应用决定它的尺寸，`scrollBeyondLastLine` 让文本滚动到最后一行之后：最多一屏（`true`，默认）、完全不（`false`）或若干行。光标移动时，它上下各保留 `cursorSurroundingLines` 行在视野内。拖动选择越过编辑器的边缘时会继续滚动，指针越远滚得越快。

`showWhitespaces` 把每个空格显示为 `·`、每个制表符显示为 `→`（`whitespace` 部件），`rulers` 在它的每一列画一条线（`ruler` 部件），作为行长度的参考线。

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

<a id="methods"></a>

## 方法

`ref={editor}` 提供编辑器的方法（`EditorRef`），供应用的按钮、菜单和按键使用。返回值的方法（`value()`、`selections()`、`replaceAll()`、`canUndo()`、`caretBounds()`、`folds()` 等）在 JS 中返回一个 `Promise`，所以要 `await` 它们：`const text = await editor.value()`。

| 方法 | 说明 |
|---|---|
| `focus()`、`blur()` | 获得焦点，或放弃焦点。 |
| `value()` | `Promise<string>`：文本。 |
| `setValue(value)` | 替换文本，作为一次可撤销的编辑。 |
| `insert(text)` | 在每个选区处原样输入 `text`（括号不会自动闭合）。 |
| `edit(edits)` | 应用一组 `{ range, text }` 替换（范围指当前文本；与前一个重叠的会被跳过），作为撤销一次撤回的一步；选区随周围的文本移动。代码操作和格式化的编辑由它完成。 |
| `selections()` | `Promise<EditorSelection[]>`：每个选区 `{ anchor, head }`，主选区（最新的）在最后。 |
| `setSelections(selections)` | 设置选区（最后一个为主选区），并把主选区滚动到视野中。 |
| `run(command)` | 执行一个命令，与它的按键效果相同（[命令](#commands)）。 |
| `replace(text)` | 替换当前匹配项并选中下一个。 |
| `replaceAll(text)` | `Promise<number>`：把所有匹配项作为一次编辑替换；返回数量。 |
| `fold(line)`、`unfold(line)` | 折叠第 `line` 行（从 0 开始）下面的行，或展开它。 |
| `foldRecursive(line)`、`unfoldRecursive(line)` | 折叠第 `line` 行的折叠及其中的每个折叠，或把它们全部展开。 |
| `foldLevel(level)` | 折叠嵌套层级为 `level` 的每个折叠（1：最外层）。 |
| `foldRange(range)` | 折叠 `range`（`{ startLine, endLine }`）中的行，不论折叠从哪里开始。 |
| `folds()` | `Promise<EditorFoldRange[]>`：已折叠的范围，包括嵌套的。 |
| `setFolds(folds)` | 恰好折叠 `folds`。 |
| `scrollToLine(line)` | 把第 `line` 行滚动到视野中，并展开隐藏它的折叠。 |
| `canUndo()`、`canRedo()` | `Promise<boolean>`：是否有可以撤销或重做的编辑。 |
| `caretBounds()` | `Promise<EditorBounds \| null>`：主光标的框 `{ bounds, pageBounds }`，在编辑器中（已计入它的滚动）和在根视图中；编辑器布局之前为 `null`。 |
| `rangeBounds(range)` | `Promise<EditorBounds[]>`：`range` 的框，它覆盖的每一行一个。 |
| `scrollOffset()`、`setScrollOffset(offset)` | `Promise<Point>`：文本滚动了多远；把它滚动到 `{ x, y }`。 |
| `visibleRange()` | `Promise<EditorRange>`：视口显示的文本，从第一行的开头到最后一行的结尾。 |
| `selectedText()` | `Promise<string>`：主选区的文本。 |
| `offsetToPosition(offset)`、`positionToOffset(position)` | `Promise<EditorPosition>`、`Promise<number>`：在 `value()` 的 UTF-16 偏移和位置之间转换。 |
| `revealPosition(position, center)` | 把 `position` 滚动到视野中，并展开隐藏它的折叠；`center` 时滚动到中间。 |
| `goToLine(line)` | 把光标放到第 `line` 行（从 0 开始）的开头，并把它滚动到中间。 |
| `showCompletions()` | 在光标处请求补全，以光标前的单词为查询（[补全](#补全)）。 |
| `presentCompletions(id, items, incomplete?)` | 回应补全请求 `id`：列表显示 `items`，按此后输入的内容过滤；设置 `incomplete` 时继续输入会再次请求。没有项时列表关闭。 |
| `hideCompletions()` | 关闭补全列表。 |
| `presentInlineCompletion(id, text)`、`hideInlineCompletion()` | 以 `text` 回应行内补全请求 `id`，显示在光标处；清除它。 |
| `presentDefinitionLink(id, range)`、`hideDefinitionLink()` | 回应定义请求 `id`（触发方式 `"hover"`）：给 `range` 加上链接的下划线（[跳转到定义](#跳转到定义与代码操作)）；隐藏它。 |

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

<a id="commands"></a>

### 命令

`run` 按名称接受编辑器的命令（`EditorCommand`）：

| 命令 | 作用 |
|---|---|
| `moveLeft`、`moveRight`、`moveUp`、`moveDown`、`moveWordLeft`、`moveWordRight`、`moveLineStart`、`moveLineEnd`、`movePageUp`、`movePageDown`、`moveDocumentStart`、`moveDocumentEnd` | 移动光标。 |
| `selectLeft`、`selectRight`、`selectUp`、`selectDown`、`selectWordLeft`、`selectWordRight`、`selectLineStart`、`selectLineEnd`、`selectPageUp`、`selectPageDown`、`selectDocumentStart`、`selectDocumentEnd` | 扩展选区。 |
| `moveToMatchingBracket` | 跳到与光标处括号匹配的括号。 |
| `selectAll`、`selectLine`、`selectWord`、`selectNextOccurrence`、`selectPreviousOccurrence`、`selectAllOccurrences` | 选择。 |
| `moveSubwordLeft`、`moveSubwordRight`、`selectSubwordLeft`、`selectSubwordRight` | 按单词的一部分（camelCase 的大写处、snake_case 的各段）移动或扩展。 |
| `moveParagraphUp`、`moveParagraphDown`、`selectParagraphUp`、`selectParagraphDown` | 移动或扩展到段落前后的空行。 |
| `expandSelection`、`shrinkSelection` | 按单位扩大选区，或缩回。 |
| `undoSelection`、`redoSelection` | 回到上一次移动之前的选区，或再前进。 |
| `splitSelectionIntoLines` | 把每个选区拆成每行一个。 |
| `addCaretAbove`、`addCaretBelow`、`singleSelection` | 添加光标；回到一个选区。 |
| `deleteBackward`、`deleteForward`、`deleteWordLeft`、`deleteWordRight`、`deleteToLineStart`、`deleteToLineEnd`、`deleteLine` | 删除。 |
| `newline`、`newlineBelow`、`newlineAbove`、`indent`、`outdent`、`toggleComment`、`toggleBlockComment` | 行、缩进与注释。 |
| `sortLinesAscending`、`sortLinesDescending` | 对所选的行排序（只有一个光标时为所有行）。 |
| `transformToUppercase`、`transformToLowercase`、`transformToTitleCase` | 改变选区的大小写（光标：它所在的单词）。 |
| `trimTrailingWhitespace` | 删除每行末尾的空白。 |
| `moveLinesUp`、`moveLinesDown`、`duplicateLinesUp`、`duplicateLinesDown`、`joinLines`、`transposeCharacters` | 重新排列。 |
| `undo`、`redo` | 撤销和重做。 |
| `fold`、`unfold`、`foldAll`、`unfoldAll` | 在光标所在行折叠，或折叠全部。 |
| `foldRecursive`、`unfoldRecursive` | 折叠光标所在的折叠及其中的每个折叠，或把它们展开。 |
| `foldSelection` | 折叠每个跨越多行的选区中的行。 |
| `findNext`、`findPrevious` | 选中 `search` 的下一个或上一个匹配项。 |
| `findWithSelection` | 为查找栏报告选中的文本（`onFindWithSelection`）。 |
| `copy`、`cut`、`paste` | 剪贴板。 |
| `showCompletions` | 在光标处请求补全（[补全](#补全)）。 |
| `goToDefinition` | 请求光标处单词的定义（`onDefinitionRequest`，触发方式 `"key"`）。 |
| `showCodeActions` | 请求选区处的代码操作（`onCodeActionRequest`）。 |

<a id="styling-the-parts"></a>

## 部件样式

`class` 和 `style` 设置编辑器盒子的样式。`classes` 按部件接受 Tailwind 类，`styles` 按部件接受内联样式；部件的类在它自己的默认样式之后应用，因此优先，它的 `styles` 又优先于类。字体用 `fontFamily`、`fontSize` 和 `lineHeight` 设置，编辑器用它们测量文本。

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

| 部件 | 是什么 | 默认值 |
|---|---|---|
| `gutter` | 行号和折叠标记所在的列 | 数字前 12pt，标记后 4pt |
| `lineNumber` | 每个行号 | 右对齐，`muted-foreground` |
| `activeLineNumber` | 有光标的行的行号，在 `lineNumber` 之后应用 | `foreground` |
| `foldMarker` | 折叠开始处那一行的标记 | `⌄`，折叠后为 `›`，`muted-foreground` |
| `content` | 行号栏旁边的文本区域 | 文本前 4pt |
| `line` | 每一行文本 | |
| `activeLine` | 有光标的行的背后，位于滚动指示条下方 | `muted`，很淡 |
| `selection` | 所选文本的背后 | `primary` 的浅色 |
| `caret` | 光标 | 2pt 宽，`foreground`，闪烁 |
| `composition` | 输入法正在组合的文本 | 下划线 |
| `searchMatch` | `search` 的匹配项 | 半透明的琥珀色 |
| `currentSearchMatch` | 选区所在的匹配项，在 `searchMatch` 之后应用 | 更深的琥珀色 |
| `matchingBracket` | 光标处的括号和与它配对的括号 | 1pt 边框 |
| `indentGuide` | 每级缩进一条参考线 | 一条 1pt 的 `border` 线 |
| `foldPlaceholder` | 折叠行在其文本之后显示的内容 | ` ⋯ `，`muted-foreground` |
| `placeholder` | 文本为空时显示 | `muted-foreground` |
| `diagnosticError` | 错误下方的线 | `destructive` |
| `diagnosticWarning` | 警告下方的线 | 琥珀色 |
| `diagnosticInfo` | 信息下方的线 | 蓝色 |
| `diagnosticHint` | 提示下方的线 | `muted-foreground` |
| `unnecessaryText` | `unnecessary` 诊断的文本 | `muted-foreground` |
| `deprecatedText` | `deprecated` 诊断的文本 | 删除线 |
| `whitespace` | 空格和制表符的标记（`showWhitespaces`） | `·` 和 `→`，`muted-foreground` 的 60 % |
| `ruler` | `rulers` 的线 | 1 点宽的 `border` 线 |
| `selectionHandle` | 触摸选区两端手柄的圆点 | 10pt 的 `primary` 圆点 |
| `selectionHandleStart`、`selectionHandleEnd` | 起点的圆点（在其行上方）和终点的圆点（在其行下方），在 `selectionHandle` 之后 | |
| `completionMenu` | 补全列表的框 | `popover`、1pt 的 `border`、圆角、阴影 |
| `completionItem` | 列表的每一项 | 一行的高度，8pt 的内边距 |
| `selectedCompletionItem` | 选中的项，在 `completionItem` 之后 | `accent` |
| `completionMatch` | 标签中与查询匹配的字母 | 半粗体，`primary` |
| `completionDetail` | 一项的详情，在标签之后 | 右对齐，`muted-foreground` |
| `completionKind` | 一项的种类，在标签之前 | 简短的名称（`fn`、`var`、`cls`），`muted-foreground` |
| `completionDocumentation` | 选中项的文档，在列表旁边 | 同 `completionMenu`，最宽 320pt |
| `inlineCompletion` | 光标处的行内补全 | `muted-foreground` |
| `definitionLink` | 定义链接的下划线 | 文本下方一条 1pt 的 `primary` 线 |

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | | 文本，由应用控制（在 `onChange` 中重新设置）。 |
| `defaultValue` | `.default_value(..)` | `string` | | 编辑器自己保存文本时的初始文本。 |
| `language` | `.language(..)` | `string` | 纯文本 | 语言的名称、别名、扩展名或文件名（[语言](#languages)）。 |
| `placeholder` | `.placeholder(..)` | `string` | | 文本为空时显示。 |
| `readOnly` | `.read_only(..)` | `boolean` | `false` | 文本可以选择和复制，不能修改。 |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | 出现时获得焦点。 |
| `lineNumbers` | `.line_numbers(..)` | `boolean` | `true` | 行号栏中的行号。 |
| `softWrap` | `.soft_wrap(..)` | `boolean` | `false` | 长行在编辑器的宽度处换行。 |
| `tabSize` | `.tab_size(..)` | `number` | 语言的设置 | 一个制表符和一级缩进的列数。 |
| `hardTabs` | `.hard_tabs(..)` | `boolean` | 语言的设置 | 用制表符缩进。 |
| `folding` | `.folding(..)` | `boolean` | `true` | 缩进的行可以用行号栏中的标记折叠。 |
| `foldRanges` | `.fold_ranges(..)` | `EditorFoldRange[]` | 按缩进 | 折叠开始的地方，由应用给出（[折叠](#folding)）。 |
| `highlighting` | `.highlighting(..)` | `boolean` | `true` | 内置的语法高亮（[应用自己的高亮](#your-own-highlighting)）。 |
| `autoClose` | `.auto_close(..)` | `boolean` | `true` | 括号和引号在输入时自动闭合。 |
| `autoIndent` | `.auto_indent(..)` | `boolean` | `true` | 新行保持缩进，并在左括号之后增加缩进。 |
| `activeLine` | `.active_line(..)` | `boolean` | `true` | 高亮有光标的行。 |
| `indentGuides` | `.indent_guides(..)` | `boolean` | `true` | 缩进参考线。 |
| `scrollBeyondLastLine` | `.scroll_beyond_last_line(..)` | `boolean \| number` | `true` | 文本可以滚动到最后一行之后：最多一屏（`true`）、完全不（`false`）或若干行。 |
| `fontFamily` | `.font_family(..)` | `string` | 主题的 `font-mono` | 绘制和测量文本所用的字体。 |
| `fontSize` | `.font_size(..)` | `number` | `13` | 字号，单位为点。 |
| `lineHeight` | `.line_height(..)` | `number` | `20` | 一行的高度，单位为点。 |
| `search` | `.search(..)` | `EditorSearch` | | 要查找的内容（[查找与替换](#find-and-replace)）。 |
| `diagnostics` | `.diagnostics(..)` | `EditorDiagnostic[]` | `[]` | 要标记的问题（[诊断](#diagnostics)）。 |
| `decorations` | `.decorations(..)` | `EditorDecoration[]` | `[]` | 应用设置样式的范围（[装饰](#decorations)）。 |
| `classes` | `.classes(..)` | `EditorClasses` | `{}` | 按部件的 Tailwind 类。 |
| `styles` | `.styles(..)` | `EditorStyles` | `{}` | 按部件的内联样式，优先于类。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | | 读屏软件对编辑器的称呼。 |
| `showWhitespaces` | `.show_whitespaces(..)` | `boolean` | `false` | 空格和制表符显示为 `·` 和 `→`。 |
| `rulers` | `.rulers(..)` | `number[]` | `[]` | 要画竖线的列。 |
| `minRows` | `.min_rows(..)` | `number` | | 编辑器从这么多行起随文本增高（[尺寸与滚动](#size-and-scrolling)）。 |
| `maxRows` | `.max_rows(..)` | `number` | | 编辑器随文本增高到这么多行，之后滚动。 |
| `cursorSurroundingLines` | `.cursor_surrounding_lines(..)` | `number` | `1` | 光标上下保留在视野内的行数。 |
| `completion` | `.completion(..)` | `boolean` | `false` | 编辑器请求建议并把它们显示为列表（[补全](#补全)）。 |
| `completionTriggerCharacters` | `.completion_trigger_characters(..)` | `string[]` | `[]` | 输入时还会请求补全的字符。 |
| `inlineCompletionDelay` | `.inline_completion_delay(..)` | `number` | `300` | 停止输入多少毫秒后请求行内补全。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | | 编辑器的盒子。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value: &SharedString\| ..)` | 文本改变了：完整的新文本。 |
| `onSelectionChange` | `.on_selection_change(\|selections: &Vec<EditorSelection>\| ..)` | 选区改变了：所有选区，主选区在最后。 |
| `onFocus`、`onBlur` | `.on_focus(\|\| ..)`、`.on_blur(\|\| ..)` | 编辑器获得或失去焦点。 |
| `onSearchChange` | `.on_search_change(\|result: &EditorSearchResult\| ..)` | 搜索的匹配项改变了：`{ count, current, error }`。 |
| `onLineNumberPress` | `.on_line_number_press(\|line: &u32\| ..)` | 行号被点击：行号，从 0 开始。 |
| `onContextMenu` | `.on_context_menu(\|event: &EditorContextMenuEvent\| ..)` | 在文本上按下了辅助按键，或触摸选中了文本：`{ position, x, y, selection? }`。 |
| `onHover` | `.on_hover(\|event: &EditorHoverEvent\| ..)` | 鼠标停在一个字符上（[语言功能](#language-features)）。 |
| `onHoverEnd` | `.on_hover_end(\|\| ..)` | 悬停结束了。 |
| `onTextPress` | `.on_text_press(\|event: &EditorTextPressEvent\| ..)` | 一个字符被点击：带有它的单词、修饰键和点击次数。 |
| `onFindWithSelection` | `.on_find_with_selection(\|query: &String\| ..)` | 执行了 `findWithSelection`：作为查找栏查询内容的文本。 |
| `onFoldChange` | `.on_fold_change(\|folds: &Vec<EditorFoldRange>\| ..)` | 已折叠的范围改变了：每一个，包括嵌套的。 |
| `onCompletionRequest` | `.on_completion_request(\|event: &EditorCompletionRequest\| ..)` | 编辑器请求补全：`{ id, offset, position, query, queryStart, trigger, character? }`（[补全](#补全)）。 |
| `onCompletionAccept` | `.on_completion_accept(\|event: &EditorCompletionAcceptEvent\| ..)` | 一项被接受并插入：`{ item }`。 |
| `onInlineCompletionRequest` | `.on_inline_completion_request(\|event: &EditorInlineCompletionRequest\| ..)` | 输入停顿了：`{ id, offset, position }`，用于行内补全。 |
| `onDefinitionRequest` | `.on_definition_request(\|event: &EditorDefinitionRequest\| ..)` | 编辑器请求一个定义：`{ id, position, offset, range, trigger }`（[跳转到定义](#跳转到定义与代码操作)）。 |
| `onCodeActionRequest` | `.on_code_action_request(\|event: &EditorCodeActionRequest\| ..)` | 用户请求代码操作：`{ range, position, bounds? }`。 |

<a id="accessibility"></a>

## 无障碍

读屏软件用 `accessibilityLabel` 称呼编辑器；它的焦点就是一个文本输入框的焦点，所以平台的文本服务（输入法、听写、软键盘）都能在其中使用。

<a id="related"></a>

## 相关内容

- [TextView](./text-view.md)：Markdown 和 HTML 文档，其代码块与编辑器使用相同的语法颜色。
- [DiffView](./diff-view.md)：两段文本之间的改动，使用编辑器的语法颜色。
- [Input](./input.md)：单行和多行文本框，使用平台自己的编辑。
- [`keymap`](../modules/nsh.md#keymap)：应用为编辑器命令绑定的按键。
- [`nsh/base`](../modules/nsh-base.md)：其他基础组件。
