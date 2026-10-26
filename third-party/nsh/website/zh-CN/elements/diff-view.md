---
title: DiffView
description: DiffView 组件：两段文本之间或一个补丁中的改动，并排或合并显示，高亮行内改动的单词，未改动的行折叠成可以展开的分隔行，带语法高亮、自动换行、针对每处改动的操作、行选择和评审批注。
order: 26.3
group: base
demo: el-diff-view
---

# DiffView

`DiffView` 像代码评审工具那样显示两段文本之间的改动：并排显示时旧文本在左、新文本在右，行与行对齐；合并显示时删除的行在新增的行上方。改动的行内，变化的单词会被高亮；改动之间未改动的行折叠成可以展开的分隔行；文本使用 [`Editor`](./editor.md) 的语法颜色高亮。它显示两段文本（`oldValue` 和 `newValue`）或统一 diff 格式中的各个文件（`patch`：`git diff` 的输出、拉取请求的 diff），每个文件位于自己的标题之下，为评审改动而设计，其中包括 AI 提出的修改：应用在每处改动上的操作可以保留或撤销它。只创建视野中的行，所以长文件滚动起来与短文件一样流畅。

`DiffView` 负责行为，并带有一套由主题令牌构成的默认外观：主题的 `font-mono`，13pt 字号、20pt 行高，行号用 `muted-foreground`，新增的行染上绿色、删除的行染上红色，改动的单词颜色更深，每个改动行的行号栏边缘有一条竖条，分隔行在 `muted` 底色上。每个部件都在这些默认值之上接受应用的样式（`classes` 和 `styles`）。Rust 用 `nsh_base::diff_view()` 创建它，TSX 用 `nsh/base` 中的 `<DiffView>`。

```rust tabs
use nsh_base::diff_view;
use nsh_core::prelude::*;

const OLD: &str = "fn total(prices: &[u32]) -> u32 {\n    prices.iter().sum()\n}\n";
const NEW: &str = "fn total(prices: &[u64]) -> u64 {\n    prices.iter().copied().sum()\n}\n";

fn review() -> impl IntoElement {
    diff_view().old_value(OLD).new_value(NEW).language("rust").flex_1()
}
```

```tsx tabs
import { mount } from "nsh";
import { DiffView } from "nsh/base";

const OLD = `fn total(prices: &[u32]) -> u32 {
    prices.iter().sum()
}
`;
const NEW = `fn total(prices: &[u64]) -> u64 {
    prices.iter().copied().sum()
}
`;

function App() {
  return <DiffView oldValue={OLD} newValue={NEW} language="rust" class="flex-1" />;
}

mount(App);
```

视图填满应用给它的盒子（`flex-1`、一个高度），在其中滚动：纵向滚动所有行，横向滚动到最长的一行，并排视图的两侧一起滚动。设置 `softWrap` 时长行在这一侧的宽度处换行，并排的一行和较高的一侧一样高，两侧始终对齐。

<a id="two-texts-or-a-patch"></a>

## 两段文本或一个补丁

- **两段文本**：`oldValue` 和 `newValue`。逐行按原样比较，所以增加或去掉末尾的换行符也是一处改动，与 git 的显示相同。
- **一个补丁**：`patch`，一个或多个文件的统一 diff（`git diff`、`git format-patch`、`diff -u`；重命名、文件模式、新增、删除和二进制文件，以及前面的提交信息，都按 git 的写法读取）。视图显示它各个 hunk 的行，行号与文件中相同，每个 hunk 位于显示其标题（所在的函数）的分隔行之下；有多个文件时，每个文件位于自己的标题之下（[补丁中的文件](#files-of-a-patch)）。未设置 `language` 时，由每个文件的路径决定它的语言。

```tsx
const PATCH = `diff --git a/src/total.rs b/src/total.rs
--- a/src/total.rs
+++ b/src/total.rs
@@ -10,3 +10,3 @@ impl Cart {
-    fn total(&self) -> u32 {
+    fn total(&self) -> u64 {
         self.prices.iter().sum()
     }
`;

<DiffView patch={PATCH} layout="unified" class="flex-1" />
```

`language` 的写法与 `Editor` 相同：名称、别名、扩展名或文件名（`"rust"`、`"tsx"`、`"main.go"`、`"Dockerfile"`）。

<a id="files-of-a-patch"></a>

## 补丁中的文件

包含多个文件的补丁把每个文件显示在一个标题行之下：默认显示它的路径（重命名时为 `旧 → 新`）、新增和删除的行数，以及 `▾`；点击标题会把文件折叠到只剩标题（`▸`），或重新展开。`renderFileHeader` 按应用的方式绘制标题（只有一个文件的补丁也会显示标题），并告诉它这个文件（`DiffFile`）：`index`、`path`、`oldPath`（重命名或复制的来源）、`status`（`"modified"`、`"added"`、`"deleted"`、`"renamed"`、`"copied"`）、`binary`（补丁中没有它的行）、`added`、`deleted`、`hunks`、`firstHunk` 和 `collapsed`。应用的标题调用 ref 的 `toggleFile(path)`；`collapseFile` 和 `expandFile` 设置折叠状态，每次变化都由 `onFileToggle(file)` 报告。新的 `patch` 仍包含某个已折叠的文件时，它保持折叠。

改动跨文件按顺序计数：一个文件的改动是第 `firstHunk` 到第 `firstHunk + hunks - 1` 处，`goToHunk`、`renderHunkActions` 和 `hunks()` 都用这个序号（`DiffHunk` 的 `file` 是它所在文件的序号，它的行号在该文件中计数），`stats()` 是所有文件之和。`goToHunk` 会先展开已折叠的文件。

```tsx
let diff!: DiffViewRef;
const files = signal<DiffFile[]>([]);

<View class="flex-1 flex-row">
  <View class="w-48">
    <Each of={files()}>
      {(file) => (
        <Button onPress={() => diff.scrollToFile(file().path)} class="px-2 py-1">
          <Text class="text-sm">{file().path} +{file().added} −{file().deleted}</Text>
        </Button>
      )}
    </Each>
  </View>
  <DiffView
    ref={(r) => {
      diff = r;
      r.files().then((list) => files.set(list));
    }}
    patch={PULL_REQUEST}
    renderFileHeader={(file) => (
      <Button onPress={() => diff.toggleFile(file.path)} class="flex-1 flex-row items-center gap-2 bg-muted px-2">
        <Text>{file.collapsed ? "▸" : "▾"}</Text>
        <Text class="flex-1 text-sm font-medium">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</Text>
        <Text class="text-xs text-muted-foreground">{file.binary ? "Binary" : file.status}</Text>
      </Button>
    )}
    class="flex-1"
  />
</View>
```

<a id="layout-and-inline-changes"></a>

## 布局与行内改动

`layout` 是 `"split"`（默认：并排，每个删除的行放在与它最相似的新增行旁边）或 `"unified"`（一列，一处改动的删除行在新增行上方，两种行号都显示）。`inline` 决定改动行内高亮什么：

| `inline` | 高亮的内容 |
|---|---|
| `"wordAlt"`（默认） | 改动的单词，相隔一个字符时合并，使改动的短语作为一个整体呈现 |
| `"word"` | 每个改动的单词 |
| `"char"` | 每个改动的字符 |
| `"none"` | 不高亮：只有行的底色 |

单词是由字母、数字和 `_` 组成的连续字符；每个汉字、假名和韩文音节各自是一个单词，所以句子中改动了一个字时只标记这一个字。几乎整行都改动了的行只显示行的底色。

`indicators` 在行号旁标记改动的行：`"bars"`（默认，行号栏边缘的一条竖条）、`"classic"`（文本前的 `+` 和 `−`）或 `"none"`。`background={false}` 让改动的行不染色，`lineNumbers={false}` 隐藏行号。

```tsx
<DiffView oldValue={before()} newValue={after()} language="md" layout="unified" inline="word" indicators="classic" class="flex-1" />
```

<a id="collapsed-lines"></a>

## 折叠的行

每处改动周围显示 `contextLines` 行未改动的行（默认 3 行）；改动之间、第一处改动之前和最后一处改动之后未改动的行折叠成一个分隔行，标明它隐藏了多少行。点击它会显示全部。`expandAll` 显示所有行；ref 的 `expand`、`expandAll()` 和 `collapseAll()` 由应用展开和折叠它们。

`renderSeparator` 按应用的方式绘制分隔行。它得到分隔行的信息（`DiffSeparator`）：`gap`，折叠段的序号（第一处改动之前为 0，改动 `i - 1` 和 `i` 之间为 `i`）；`lines`，隐藏的行数；`first` 和 `last`；补丁的话还有 hunk 的 `header`。`expand(gap, direction, lines)` 显示 `"all"`，即全部行（默认），或者 `lines` 行（默认 20 行）：`"up"` 是分隔行下方那处改动紧上方的行，`"down"` 是分隔行上方那处改动紧下方的行。第一个分隔行向上展开，最后一个向下展开。

```tsx
let diff!: DiffViewRef;

<DiffView
  ref={diff}
  oldValue={before()}
  newValue={after()}
  language="ts"
  renderSeparator={(sep) => (
    <View class="flex-1 flex-row items-center gap-1 bg-muted px-2">
      <If when={!sep.first}>
        <Button onPress={() => diff.expand(sep.gap, "down")} class="px-1"><Text>↓</Text></Button>
      </If>
      <If when={!sep.last}>
        <Button onPress={() => diff.expand(sep.gap, "up")} class="px-1"><Text>↑</Text></Button>
      </If>
      <Button onPress={() => diff.expand(sep.gap)} class="flex-1">
        <Text class="text-xs text-muted-foreground">{sep.header ?? `${sep.lines} unchanged lines`}</Text>
      </Button>
    </View>
  )}
  class="flex-1"
/>
```

<a id="keeping-and-reverting-changes"></a>

## 保留和撤销改动

`renderHunkActions` 把应用的操作放在视野中每处改动的右上角，并告诉它这处改动（`DiffHunk`：`index`、`oldStart`、`oldLines`、`newStart`、`newLines`，行号从 0 开始；以及 `file`，补丁中它所在文件的序号）。这些操作调用 ref：`revertHunk(index)` 把这处改动的旧行放回新文本，`acceptHunk(index)` 让它的新行成为旧文本的内容。视图立即显示结果，并用 `onChange({ oldValue, newValue })` 报告两段文本，由应用把它们设为属性。逐处保留或撤销 AI 的修改就是这样：

```tsx
import { signal, Text, View } from "nsh";
import { Button, DiffView, type DiffViewRef } from "nsh/base";

function Proposal(props: { file: string; current: string; proposed: string; onApply: (text: string) => void }) {
  let diff!: DiffViewRef;
  const current = signal(props.current);
  const proposed = signal(props.proposed);
  return (
    <View class="flex-1">
      <DiffView
        ref={diff}
        oldValue={current()}
        newValue={proposed()}
        language={props.file}
        onChange={({ oldValue, newValue }) => {
          current.set(oldValue);
          proposed.set(newValue);
          props.onApply(oldValue);
        }}
        renderHunkActions={(hunk) => (
          <View class="flex-row gap-1">
            <Button onPress={() => diff.revertHunk(hunk.index)} class="rounded bg-background px-2 py-0.5 border border-border">
              <Text class="text-xs">Revert</Text>
            </Button>
            <Button onPress={() => diff.acceptHunk(hunk.index)} class="rounded bg-primary px-2 py-0.5">
              <Text class="text-xs text-primary-foreground">Keep</Text>
            </Button>
          </View>
        )}
        class="flex-1"
      />
    </View>
  );
}
```

这里旧文本就是文件现在的内容：保留一处改动就把它应用到文件（`onApply`），撤销它就把它从提议中去掉。显示 `patch` 的视图显示的是文件的片段，它的改动保持原样。

<a id="methods"></a>

## 方法

`ref={diff}` 提供视图的方法（`DiffViewRef`）。返回值的方法（`hunks()`、`stats()`）在 JS 中返回一个 `Promise`，所以要 `await` 它们：`const changes = await diff.hunks()`。要在界面上显示的统计数字，由 `onStatsChange` 在变化时报告。

| 方法 | 说明 |
|---|---|
| `hunks()` | `Promise<DiffHunk[]>`：所有改动，按顺序。 |
| `stats()` | `Promise<DiffStats>`：`{ added, deleted, hunks }`，新增和删除的行数，以及改动的数量。 |
| `goToHunk(index)` | 把第 `index` 处改动滚动到视野中，它的第一行在顶部。 |
| `revertHunk(index)` | 把第 `index` 处改动的旧行放回新文本，并报告两段文本（`onChange`）。 |
| `acceptHunk(index)` | 让第 `index` 处改动的新行成为旧文本的内容，并报告两段文本（`onChange`）。 |
| `expand(gap, direction?, lines?)` | 显示分隔行 `gap` 隐藏的行：`"all"`（默认），或者 `lines` 行（默认 20 行），`"up"` 或 `"down"`。 |
| `expandAll()` | 显示所有未改动的行。 |
| `collapseAll()` | 重新折叠未改动的行。 |
| `nextHunk()` | `Promise<number \| null>`：把下一处改动滚动到顶部，并给出它的序号（最后一处之后是第一处）。 |
| `previousHunk()` | `Promise<number \| null>`：把上一处改动滚动到顶部，并给出它的序号（第一处之前是最后一处）。 |
| `currentHunk()` | `Promise<number \| null>`：视图仍停在上次跳转到的改动时就是它，否则是视图顶部的改动，或视野中的第一处。 |
| `selectedLines()` | `Promise<DiffLineRange \| null>`：在行号上选中的行。 |
| `setSelectedLines(range)` | 选中一侧的若干行（`null`：不选），不触发 `onLineSelectionChange`。 |
| `selectedText()` | `Promise<string>`：选中各行的文本。 |
| `files()` | `Promise<DiffFile[]>`：补丁中的文件，按顺序，带有各自的统计数字（两段文本时为空）。 |
| `scrollToFile(path)` | 把路径为 `path` 的文件的标题滚动到顶部。 |
| `collapseFile(path)` | 只显示路径为 `path` 的文件的标题。 |
| `expandFile(path)` | 重新显示路径为 `path` 的文件的行。 |
| `toggleFile(path)` | 折叠路径为 `path` 的文件，已折叠时则展开它。 |

视图停在上次跳转到的改动时，`nextHunk()` 和 `previousHunk()` 从那处改动继续，否则从视图顶部算起，所以靠近末尾、无法滚动到顶部的改动也会被数到。上一处和下一处改动的按钮，以及来自 `onStatsChange` 的统计数字：

```tsx
let diff!: DiffViewRef;
const stats = signal<DiffStats>({ added: 0, deleted: 0, hunks: 0 });

<View class="flex-row items-center gap-2 p-2">
  <Text class="text-sm text-green-600">+{stats().added}</Text>
  <Text class="text-sm text-red-600">−{stats().deleted}</Text>
  <Text class="text-sm text-muted-foreground">{stats().hunks} changes</Text>
  <Button onPress={() => diff.previousHunk()}><Text>Previous</Text></Button>
  <Button onPress={() => diff.nextHunk()}><Text>Next</Text></Button>
</View>
<DiffView ref={diff} oldValue={before()} newValue={after()} onStatsChange={(s) => stats.set(s)} class="flex-1" />
```

<a id="review-comments"></a>

## 评审评论

行号用来选中一侧的行：点击选中一行，按住 Shift 点击把选区扩展到这一行，用鼠标在行号上拖动选中经过的各行。`onLineSelectionChange` 报告选中的行（`DiffLineRange`：`{ side, start, end }`，行号从 0 开始，没有选中时为 `null`），点击行号还会报告 `onLineNumberPress({ side, line })`。ref 读取选区（`selectedLines()`、`selectedText()`）并可以设置它。

`annotations` 把应用的内容放在行的下方：每个 `{ id, side, line }` 由 `renderAnnotation` 绘制，横跨所在行的一侧（合并显示时横跨整个视图），高度就是它布局后的高度，所在的行显示时它也显示。`renderAddAnnotation` 是应用用来添加批注的控件，显示在指针所在行和最后一个选中行的行号栏右侧；所在行被选中时它拿到选中的各行，否则拿到这一行。

```tsx
type Comment = { id: string; side: "old" | "new"; line: number; text: string };
const comments = signal<Comment[]>([]);
const drafting = signal<DiffLineRange | null>(null);

<DiffView
  oldValue={before()}
  newValue={after()}
  annotations={comments().map(({ id, side, line }) => ({ id, side, line }))}
  renderAnnotation={(a) => (
    <View class="m-2 rounded-md border border-border bg-card p-2">
      <Text class="text-sm">{comments().find((c) => c.id === a.id)?.text}</Text>
    </View>
  )}
  renderAddAnnotation={(range) => (
    <Button onPress={() => drafting.set(range)} class="size-4 items-center justify-center rounded bg-primary">
      <Text class="text-xs text-primary-foreground">+</Text>
    </Button>
  )}
  class="flex-1"
/>
```

<a id="styling-the-parts"></a>

## 部件样式

`class` 和 `style` 设置视图盒子的样式。`classes` 按部件接受 Tailwind 类，`styles` 按部件接受内联样式；部件的类在它自己的默认样式之后应用，因此优先，它的 `styles` 又优先于类。字体用 `fontFamily`、`fontSize` 和 `lineHeight` 设置。

```tsx
<DiffView
  oldValue={before()}
  newValue={after()}
  language="py"
  fontSize={12}
  lineHeight={18}
  class="flex-1 rounded-lg border border-border"
  classes={{
    gutter: "bg-muted",
    lineAdded: "bg-blue-500/10",
    wordAdded: "bg-blue-500/30",
    indicatorAdded: "bg-blue-500",
    separator: "bg-transparent",
  }}
/>
```

| 部件 | 是什么 | 默认值 |
|---|---|---|
| `side` | 每一侧（并排）或唯一的一列（合并） | 两侧之间一条 `border` 线 |
| `gutter` | 一侧的行号和标记 | |
| `lineNumber` | 每个行号 | 右对齐，`muted-foreground` |
| `lineNumberAdded` | 新增行的行号，在 `lineNumber` 之后应用 | |
| `lineNumberDeleted` | 删除行的行号，在 `lineNumber` 之后应用 | |
| `content` | 一侧的文本，在行号栏旁边 | 文本前后各 8pt |
| `line` | 一侧的每一行 | |
| `lineAdded` | 新增的行，在 `line` 之后应用 | 绿色底色 |
| `lineDeleted` | 删除的行，在 `line` 之后应用 | 红色底色 |
| `filler` | 并排行中另一侧没有对应行时空着的一半 | 淡淡的 `muted` 填充 |
| `wordAdded` | 新增行内改动的单词 | 更深的绿色 |
| `wordDeleted` | 删除行内改动的单词 | 更深的红色 |
| `indicatorAdded` | 新增行的竖条（`"bars"`）或 `+`（`"classic"`） | 绿色，3pt 宽 |
| `indicatorDeleted` | 删除行的竖条或 `−` | 红色，3pt 宽 |
| `separator` | 折叠行的分隔行，或补丁的 hunk 标题 | `muted` 底色上的 `⋯` 和行数 |
| `hunkActions` | 应用在一处改动上的操作所在的盒子 | 改动的右上角 |
| `lineSelected` | 覆盖在选中各行所在一侧的行上 | 主题的选区颜色（与 `Editor` 的选区一致） |
| `annotation` | 一条批注的盒子，在所在行的下方 | 横跨所在行的一侧 |
| `addAnnotation` | 添加控件的盒子，与行号栏同宽、一行高 | 控件在它的右侧 |
| `fileHeader` | 补丁中一个文件的标题 | `secondary` 底色上的路径和行数，下方一条 `border` 线 |

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `oldValue` | `.old_value(..)` | `string` | | 旧文本。 |
| `newValue` | `.new_value(..)` | `string` | | 新文本。 |
| `patch` | `.patch(..)` | `string` | | 一个或多个文件的统一 diff，在未设置 `oldValue` 和 `newValue` 时显示。 |
| `language` | `.language(..)` | `string` | 纯文本（补丁：每个文件的语言） | 语言的名称、别名、扩展名或文件名。 |
| `layout` | `.layout(..)` | `"split" \| "unified"` | `"split"` | 并排或一列。 |
| `inline` | `.inline(..)` | `"wordAlt" \| "word" \| "char" \| "none"` | `"wordAlt"` | 改动行内高亮的内容。 |
| `indicators` | `.indicators(..)` | `"bars" \| "classic" \| "none"` | `"bars"` | 在行号旁如何标记改动的行。 |
| `contextLines` | `.context_lines(..)` | `number` | `3` | 每处改动周围显示的未改动行数。 |
| `expandAll` | `.expand_all(..)` | `boolean` | `false` | 显示所有未改动的行。 |
| `lineNumbers` | `.line_numbers(..)` | `boolean` | `true` | 行号。 |
| `background` | `.background(..)` | `boolean` | `true` | 改动的行带底色。 |
| `fontFamily` | `.font_family(..)` | `string` | 主题的 `font-mono` | 文本的字体。 |
| `fontSize` | `.font_size(..)` | `number` | `13` | 字号，单位为点。 |
| `lineHeight` | `.line_height(..)` | `number` | `20` | 一行的高度，单位为点。 |
| `renderSeparator` | `.render_separator(..)` | `(separator: DiffSeparator) => JSX.Element` | | 绘制折叠行的分隔行。 |
| `renderHunkActions` | `.render_hunk_actions(..)` | `(hunk: DiffHunk) => JSX.Element` | | 应用在每处改动上的操作。 |
| `softWrap` | `.soft_wrap(..)` | `boolean` | `false` | 长行在这一侧的宽度处换行。 |
| `annotations` | `.annotations(..)` | `DiffAnnotation[]` | `[]` | 放在行下方的应用内容：`{ id, side, line }`。 |
| `renderAnnotation` | `.render_annotation(..)` | `(annotation: DiffAnnotation) => JSX.Element` | | 在所在行的下方绘制一条批注。 |
| `renderAddAnnotation` | `.render_add_annotation(..)` | `(range: DiffLineRange) => JSX.Element` | | 应用用来添加批注的控件，在指针所在行和最后一个选中行旁边。 |
| `renderFileHeader` | `.render_file_header(..)` | `(file: DiffFile) => JSX.Element` | | 绘制补丁中每个文件的标题，高一行。 |
| `classes` | `.classes(..)` | `DiffViewClasses` | `{}` | 按部件的 Tailwind 类。 |
| `styles` | `.styles(..)` | `DiffViewStyles` | `{}` | 按部件的内联样式，优先于类。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | | 视图的盒子。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|change: &DiffChange\| ..)` | 一处改动被保留或撤销：`{ oldValue, newValue }`，现在的两段文本。 |
| `onLineNumberPress` | `.on_line_number_press(\|line: &DiffLine\| ..)` | 行号被点击：`{ side, line }`。 |
| `onLineSelectionChange` | `.on_line_selection_change(\|range: &Option<DiffLineRange>\| ..)` | 选中的行变了：`{ side, start, end }`，或 `null`。 |
| `onStatsChange` | `.on_stats_change(\|stats: &DiffStats\| ..)` | 统计数字变了：`{ added, deleted, hunks }`。视图创建时触发一次，之后每次比较文本得到不同的数字时再触发，用于显示“+8 −8 · 5 处改动”这样的一行。 |
| `onFileToggle` | `.on_file_toggle(\|file: &DiffFile\| ..)` | 补丁中的一个文件被折叠或展开（通过它的标题或 ref）：现在的 `DiffFile`。 |

<a id="related"></a>

## 相关内容

- [Editor](./editor.md)：代码编辑器，`DiffView` 使用它的语法颜色和语言。
- [TextView](./text-view.md)：Markdown 和 HTML 文档，用于评审周围的文字。
- [`nsh/base`](../modules/nsh-base.md)：其他基础组件。
