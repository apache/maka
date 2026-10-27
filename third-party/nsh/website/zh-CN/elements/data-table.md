---
title: DataTable
description: DataTable 组件：向两个方向滚动、行数和列数不限的表格，列可以固定、调整宽度、移动和排序，支持按行、列、单元格选择，行由应用分页提供，带分组标签、键盘导航和由应用绘制的单元格。
order: 26.4
group: base
demo: el-data-table
---

# DataTable

`DataTable` 像电子表格那样显示行和列，并向两个方向滚动，行数和列数都不限。只创建视野中的单元格，所以一百万行、一万列的表格滚动起来与小表格一样流畅。行、列或单元格可以用指针和键盘选择；列有固定的宽度，拖动边缘调整宽度，拖动标题移动，可以在其他列滚动时固定在左侧，也可以排序。标题可以位于分组标签之下，单元格和标题都可以由应用绘制。

`DataTable` 提供布局、对齐、虚拟化和交互。应用通过 `classes` 和 `styles` 设置各部件的内边距、颜色、边框和选中态外观。Rust 用 `nsh_base::data_table()` 创建它，TSX 用 `nsh/base` 中的 `<DataTable>`。

```rust tabs
use nsh_base::{DataTableColumn, data_table};
use nsh_core::prelude::*;

fn column(key: &str, title: &str) -> DataTableColumn {
    let mut column = DataTableColumn::default();
    column.key = key.into();
    column.title = Some(title.into());
    column
}

fn table() -> impl IntoElement {
    data_table()
        .columns(vec![column("name", "Name"), column("city", "City")])
        .flex_1()
}
```

```tsx tabs
import { mount } from "nsh";
import { DataTable, type DataTableColumn } from "nsh/base";

const columns: DataTableColumn[] = [
  { key: "name", title: "Name", width: 160, sortable: true },
  { key: "city", title: "City", width: 120 },
  { key: "score", title: "Score", width: 90, align: "end" },
];

const rows = [
  { name: "Ada", city: "Oslo", score: 91 },
  { name: "Grace", city: "Lima", score: 87 },
  { name: "Linus", city: "Kyoto", score: 78 },
];

function App() {
  return <DataTable columns={columns} data={rows} class="flex-1" />;
}

mount(App);
```

表格填满应用给它的盒子（`flex-1`、一个高度），在其中滚动：纵向滚动所有行，横向滚动所有列，带滚动条（`scrollbar={false}` 隐藏滚动条，`bounces={false}` 关闭有回弹的平台上的边缘回弹）。

<a id="rows-and-columns"></a>

## 行和列

`data` 是行：对象（字段由各列的 `key` 指定），或按位置被各列索引的数组。数字、布尔值和字符串显示为文本。列是一个 `DataTableColumn`：

| 字段 | 说明 |
|---|---|
| `key` | 列的标识，在各列中唯一：它的单元格显示的行字段，也是事件和 ref 用来称呼它的名字。 |
| `title` | 标题的文字。默认为 `key`。 |
| `width` | 宽度，单位为点。默认 `120`。 |
| `minWidth`、`maxWidth` | 拖动或适配宽度时的最小和最大宽度。默认 `20` 和 `1200`。 |
| `fitPadding` | 应用的内边距、图标或徽标需要的额外宽度，适配列宽时加到最宽的标题或单元格文字上。 |
| `align` | `"start"`（默认）、`"center"` 或 `"end"`（用于数字），单元格和标题一致。 |
| `sortable` | 标题末端有一个排序按钮，按下会请求排序（见[排序](#sorting)）。 |
| `fixed` | 其他列在它下面滚动时，它固定在左侧。固定列排在其他列之前，保持各自的顺序。 |
| `resizable`、`movable` | 拖动它的边缘是否调整宽度，拖动它的标题是否移动。默认取表格的 `resizableColumns` 和 `movableColumns`。 |
| `selectable` | 是否参与选择。按钮或复选框所在的列设为 `false`。默认 `true`。 |
| `cellClass` | 该列单元格的 classes，排在 `cell` 部件之后：单列的内边距或对齐。 |
| `headerClass` | 该列标题的 classes，排在 `headerCell` 部件之后。 |
| `positiveClass` | 该列中表示上涨的单元格的 classes：大于零的数字，或以 `+` 开头的文本。 |
| `negativeClass` | 该列中表示下跌的单元格的 classes：小于零的数字，或以 `-` 开头的文本。 |

`rowHeight` 是表体行的高度（默认 `32`），`headerHeight` 是标题行的高度（默认与行高相同）。`rowHeader` 在左侧添加一列行号，它可以选择行。`stripe` 让奇数行使用 `rowOdd` 部件。

### 分组标签

`groups` 在列的上方放置标签，从最低一层开始。每一层是一个 `{ label, span }` 列表，各 `span` 之和等于列数（或下一层的项数）。

```tsx
<DataTable
  columns={columns}
  data={rows}
  groups={[
    [{ label: "Person", span: 2 }, { label: "Result", span: 1 }],
  ]}
  class="flex-1"
/>
```

<a id="any-number-of-rows"></a>

## 任意数量的行

表格按位置请求行，由应用提供。`rowCount` 是行的总数，`data` 是应用持有的行，`dataStart` 是其中第一行的位置。`data` 之外的行在应用提供之前是空的。`onVisibleRowsChange` 在每个滚动步骤报告视野中的行 `{ start, end }`，是获取其周围一页数据的地方。

```tsx
const ROWS = 1_000_000;
const page = signal({ start: 0, rows: load(0) });

<DataTable
  columns={columns}
  data={page().rows}
  dataStart={page().start}
  rowCount={ROWS}
  onVisibleRowsChange={({ start, end }) => {
    // Keep the rows in view inside the page held.
    const held = page();
    if (start < held.start || end > held.start + held.rows.length) {
      const first = Math.max(0, start - 200);
      page.set({ start: first, rows: load(first) });
    }
  }}
  class="flex-1"
/>
```

对于在末尾不断增长的列表，设置 `hasMore`：当视野中的行进入最后一行的 `loadMoreThreshold`（默认 `20`）范围内时，`onLoadMore` 会针对每个行数触发一次。`loading` 为 true 时它会等待，`loadingView` 插槽显示在行的上方。没有行时显示 `empty` 插槽。

内容超过几百万点后，滚动条跨越的是缩放后的范围，所以一百万行仍然可以滚动到每一行。

<a id="selection"></a>

## 选择

与 gpui-component 一样，由三个开关决定按下会选择什么：

| 属性 | 按下选择 | `selection` |
|---|---|---|
| `rowSelectable`（默认 `true`） | 一行：它的任一单元格或行号 | `{ row }` |
| `columnSelectable`（默认 `true`） | 一列：它的标题 | `{ column }` |
| `cellSelectable`（默认 `false`） | 一个单元格；行号列（开启时默认显示）选择行 | `{ row, column }` |

开启 `cellSelectable` 并隐藏行号列（`rowHeader={false}`）时，再次按下已选中的单元格会选中它所在的行。按住 Shift 或平台的命令键按下时，只有 `selectOnModifierPress`（默认 `true`）为真才会选中行，这样自己维护多行选择的应用可以自行处理这些按下：`onRowPress` 报告表体的每一次按下，带有所在行、指针下的列、连续点击次数和按住的修饰键。`selectable` 为 `false` 的列，它本身和它的单元格都不会被选中。

行从数据中的 0 开始计数，列是它在 `columns` 中的索引，不受用户移动后顺序的影响。`onSelectionChange` 报告用户的选择（没有选择时为 `null`）。`selection` 属性由应用设置选择；不设置时由表格自己保存。`onDoublePress` 报告一行、一个单元格或一个标题被连按两次，`onContextMenu` 报告次要按下或长按，并给出应用打开 [`Menu`](./menu.md) 的位置。两者都指出指针下的单元格（`row` 和 `column`）、行号（只有 `row`）或标题（只有 `column`）。在下一次按下之前，请求菜单的单元格带有 `cellActive` 部件；单元格不可选时，则是它所在的行带有 `rowActive` 部件。

屏幕阅读器得到一个网格（名称来自 `accessibilityLabel`），由列标题和单元格组成，被选中的会读出为已选中。

<a id="keyboard"></a>

## 键盘

按下表格，或用 Tab 移到表格上（macOS、Web），会让它获得键盘，直到再次按下别处、焦点移走或调用 `blur()`；应用可以用 `focus()` 让它获得键盘。整张表格是 Tab 的一个停靠点：在表格里 Tab 移动选择，Escape 交出键盘。

| 按键 | 作用 |
|---|---|
| 方向键 | 按行、列或单元格移动选择，并滚动到视野中。 |
| Tab、Shift+Tab | 移动到下一列或上一列。 |
| Page Up、Page Down | 按页移动行。 |
| Home、End | 移动到第一个或最后一个。 |
| Escape | 先清除选择，再交出键盘。 |
| 复制快捷键 | 把选中内容的文字放到剪贴板（`copy()`）。 |

`loopSelection`（默认 `true`）让方向键在两端循环。

<a id="sorting"></a>

## 排序

`sortable` 的列在标题末端有一个排序按钮：一个小的 ghost 按钮，该列未排序时显示为半透明。按下它会按“未排序、升序、降序、再回到未排序”的顺序用 `onSortChange({ key, direction })` 报告下一个排序（`null` 表示清除）。表格不会重新排列行：应用自己对数据排序，或向服务器请求新顺序的行，并设置 `sort` 让标题显示出来。由于顺序归应用所有，对应用从未持有的一百万行同样适用。

```tsx
<DataTable
  columns={columns}
  data={rows()}
  sort={sort()}
  onSortChange={(next) => {
    sort.set(next ?? undefined);
    rows.set(sorted(people, next));
  }}
  class="flex-1"
/>
```

<a id="resizing-and-moving-columns"></a>

## 调整和移动列

拖动列的尾部边缘会在 `minWidth` 和 `maxWidth` 之内调整宽度，`onColumnResize(key, width)` 报告每一步。连续按两次边缘会把该列适配到最宽的文本和标题。拖动标题会移动列，并用一条线显示将放下的位置；`onColumnMove` 报告 `{ key, from, to, order }`，其中 `order` 是所有列当前顺序的 `key`。固定列只能在固定列之间移动。`resizableColumns` 和 `movableColumns` 对整个表格开关这两项，列自己的 `resizable` 和 `movable` 优先。

<a id="live-data"></a>

## 实时数据

行情表每秒会变化多次。应用只格式化视野中的行及其周围一段范围（这些行由 `onVisibleRowsChange` 告知），并把它们作为从 `dataStart` 开始的 `data` 交给表格，所以一次更新的开销取决于屏幕上的内容，与总行数无关。涨跌颜色来自列的 `positiveClass` 和 `negativeClass`，由原生代码应用到值大于或小于零（或文本以 `+`、`-` 开头）的单元格。

```tsx
const tone = { positiveClass: "text-green-600", negativeClass: "text-red-600" };
const columns: DataTableColumn[] = [
  { key: "symbol", title: "Symbol", fixed: true },
  { key: "price", title: "Price", align: "end", sortable: true },
  { key: "change", title: "Chg%", align: "end", ...tone },
];
```

行和列是表格创建一次并一直保留的槽位：滚动只是让它们显示别的行和列，所以无论滚动多远，变化的只有文字和位置。

<a id="drawing-cells-and-titles"></a>

## 绘制单元格和标题

当某一列不只是文字时（徽标、按钮），用 `renderCell` 绘制应用自己的单元格。它只为视野中的单元格调用，参数是 `DataTableCell`：`row`、`column`、`key`、`text`（表格原本会显示的文字）和 `selected`。应用按 `row` 查找自己的数据。`renderHeaderCell` 绘制铺满单元格的标题，参数是 `DataTableHeaderCell`：`column`、`key`、`title`、`sort`（方向，或无）和 `selected`。

```tsx
<DataTable
  columns={columns}
  data={rows()}
  renderCell={(cell) =>
    cell.key === "status" ? (
      <View class={cell.text === "open" ? "rounded bg-green-500/20 px-2" : "rounded bg-muted px-2"}>
        <Text class="text-xs">{cell.text}</Text>
      </View>
    ) : (
      <Text class="px-2 text-sm">{cell.text}</Text>
    )
  }
  class="flex-1"
/>
```

`fontFamily` 和 `fontSize`（默认 `14`）设置单元格的字体，表格也用它来测量文字以适配列宽。

<a id="the-ref"></a>

## Ref

`ref` 提供 `DataTableRef`：

| 方法 | 说明 |
|---|---|
| `scrollToRow(row, animated?)` | 把一行滚动到视野中。 |
| `scrollToColumn(key, animated?)` | 把一列滚动到视野中。 |
| `selection()` | 当前的选择，没有时为 `null`。 |
| `select(selection)` | 选择（`null` 表示不选）并滚动到视野中，不触发 `onSelectionChange`。 |
| `visibleRows()`、`visibleColumns()` | 视野中的行和滚动列，形如 `{ start, end }`（不含 `end`）。 |
| `columnWidths()` | 当前的宽度，按 `columns` 的顺序。 |
| `setColumnWidth(key, width)` | 在限制范围内设置列宽。 |
| `fitColumn(key)` | 把列设为其最宽文字和标题所需的宽度，范围是视野中的行及其周围最多一千行。返回宽度，没有这一列时返回 `null`。 |
| `dump(start?, end?)` | 给定行（默认全部已持有的行）和标题的文字，与显示一致：`{ headers, rows }`，用于导出。 |
| `copy()` | 把选中内容的文字放到剪贴板：一行的单元格以制表符分隔，一列的以换行分隔，一个单元格就是它的文字。 |
| `focus()`、`blur()` | 让表格获得或交出键盘。 |
| `menuTarget()`、`clearMenuTarget()` | 上一次请求上下文菜单的位置（`{ row?, column? }`，由 `cellActive` / `rowActive` 标记），以及在应用的菜单关闭时清除该标记。 |

<a id="styling-the-parts"></a>

## 为部件设置样式

`class` 和 `style` 设置表格盒子的样式。`classes` 按部件接受 Tailwind 类，`styles` 按部件接受内联样式；部件提供表格的基本结构和对齐，类设置外观，`styles` 优先于类。

```tsx
<DataTable
  columns={columns}
  data={rows()}
  stripe
  class="flex-1 rounded-lg border border-border"
  classes={{
    header: "bg-secondary",
    headerCell: "pl-2 pr-1",
    headerContent: "gap-1",
    cell: "px-2",
    resizeHandle: "bg-border group-hover:bg-primary",
    sortAscending: "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
    sortDescending: "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
    rowSelected: "bg-primary/10",
    rowHover: "bg-muted/50",
    fixedEdge: "bg-border",
  }}
/>
```

| 部件 | 说明 |
|---|---|
| `root` | 表格的盒子：边框、圆角和背景 |
| `header` | 横跨表格的标题区，包含分组标签行和标题行 |
| `groupCell` | 位于所跨各列上方的分组标签 |
| `headerCell` | 每一列的标题单元格 |
| `headerContent` | 标题文字和排序按钮的布局行，可设置两者的间距 |
| `headerCellDragging` | 正在拖动的标题，排在 `headerCell` 之后 |
| `headerCellSorted` | 表格当前排序所依据的列的标题，排在 `headerCell` 之后 |
| `headerCellSelected` | 被选中列的标题，排在 `headerCell` 之后 |
| `sortIndicator` | 可排序列的排序按钮 |
| `sortAscending`、`sortDescending` | 上下两个箭头，当前排序方向应用 `selected:` |
| `resizeHandle` | 列尾部边缘供拖动调整的线 |
| `moveIndicator` | 被拖动的列将放下的位置上的线 |
| `row` | 每一个表体行 |
| `rowOdd` | 奇数行，排在 `row` 之后（`stripe`） |
| `rowHover` | 指针所在的行，排在 `row` 之后 |
| `rowSelected` | 被选中的行，排在 `row` 之后 |
| `rowActive` | 单元格不可选时请求过上下文菜单的行，直到下一次按下，排在 `row` 之后 |
| `cell` | 每一个表体单元格 |
| `cellSelected` | 被选中的单元格，排在 `cell` 之后 |
| `cellActive` | 请求过上下文菜单的单元格，直到下一次按下，排在 `cell` 之后 |
| `cellColumnSelected` | 被选中列的单元格，排在 `cell` 之后 |
| `rowHeader` | 行号单元格 |
| `rowHeaderCorner` | 行号上方的角落 |
| `fixedEdge` | 固定列尾部边缘的线，位于在其下滚动的列之上 |
| `empty` | `empty` 插槽的盒子 |

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `columns` | `.columns(..)` | `DataTableColumn[]` | `[]` | 从左到右的列。固定列排在前面。 |
| `data` | `.data(..)` | `Row[]` | `[]` | 行：按列 `key` 取字段的对象，或按位置索引的数组。 |
| `rowCount` | `.row_count(..)` | `number` | 已持有的行数 | 行的总数。 |
| `dataStart` | `.data_start(..)` | `number` | `0` | `data` 第一行对应的行号。 |
| `rowClasses` | `.row_classes(..)` | `string[]` | `[]` | 所给各行的类名，按它们在 `data` 中的位置对应：行自己的外观，不需要每行调用 JS。 |
| `rowHeight` | `.row_height(..)` | `number` | `32` | 表体行的高度，单位为点。 |
| `headerHeight` | `.header_height(..)` | `number` | 行高 | 标题行的高度。 |
| `groups` | `.groups(..)` | `DataTableColumnGroup[][]` | `[]` | 列上方的标签，从最低一层开始。 |
| `sort` | `.sort(..)` | `DataTableSort` | | 数据的排序依据，显示在标题上。 |
| `rowSelectable` | `.row_selectable(..)` | `boolean` | `true` | 按下和按键可以选择行。 |
| `columnSelectable` | `.column_selectable(..)` | `boolean` | `true` | 按下标题会选中该列，左右键在列之间移动。 |
| `cellSelectable` | `.cell_selectable(..)` | `boolean` | `false` | 按下和按键可以选择单元格。 |
| `selectOnModifierPress` | `.select_on_modifier_press(..)` | `boolean` | `true` | 按住 Shift 或命令键按下时选中行。 |
| `selection` | `.selection(..)` | `DataTableSelection` | | 当前选择，由应用设置。 |
| `loopSelection` | `.loop_selection(..)` | `boolean` | `true` | 方向键在两端循环。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对表格的称呼。 |
| `rowHeader` | `.row_header(..)` | `boolean` | 开启 `cellSelectable` 时显示 | 左侧的一列行号。 |
| `stripe` | `.stripe(..)` | `boolean` | `false` | 奇数行使用 `rowOdd` 部件。 |
| `resizableColumns` | `.resizable_columns(..)` | `boolean` | `true` | 拖动列的边缘调整宽度。 |
| `movableColumns` | `.movable_columns(..)` | `boolean` | `true` | 拖动标题移动列。 |
| `loading` | `.loading(..)` | `boolean` | `false` | 表格正在加载：`onLoadMore` 等待，`loadingView` 显示。 |
| `hasMore` | `.has_more(..)` | `boolean` | `false` | 还有更多行可以加载。 |
| `loadMoreThreshold` | `.load_more_threshold(..)` | `number` | `20` | 距最后一行多少行时触发 `onLoadMore`。 |
| `fontFamily` | `.font_family(..)` | `string` | 继承 | 单元格的字体。 |
| `fontSize` | `.font_size(..)` | `number` | `14` | 单元格的字号，单位为点。 |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | 滚动条。 |
| `verticalScrollbar`、`horizontalScrollbar` | `.vertical_scrollbar(..)`、`.horizontal_scrollbar(..)` | `boolean` | `scrollbar` | 单个方向的滚动条（水平的是桌面平台表格下方的滚动条）。 |
| `bounces` | `.bounces(..)` | `boolean` | `true` | 滚动到边缘时是否回弹（平台支持时）。 |
| `renderCell` | `.render_cell(..)` | `(cell: DataTableCell) => JSX.Element` | | 绘制视野中的单元格。 |
| `renderHeaderCell` | `.render_header_cell(..)` | `(cell: DataTableHeaderCell) => JSX.Element` | | 绘制标题。 |
| `empty` | `.empty(..)` | `JSX.Element` | | 没有行时显示的内容。 |
| `loadingView` | `.loading_view(..)` | `JSX.Element` | | `loading` 时显示在行上方的内容。 |
| `classes` | `.classes(..)` | `DataTableClasses` | `{}` | 按部件设置的 Tailwind 类。 |
| `styles` | `.styles(..)` | `DataTableStyles` | `{}` | 按部件设置的内联样式，优先于类。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | | 表格的盒子。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onSelectionChange` | `.on_selection_change(\|selection: &Option<DataTableSelection>\| ..)` | 用户改变了选择：`{ row?, column? }`，或 `null`。 |
| `onRowPress` | `.on_row_press(\|event: &DataTablePress\| ..)` | 按下了一行或一个单元格：`{ row, column?, clicks, shift, control, alt, platform }`。 |
| `onDoublePress` | `.on_double_press(\|target: &DataTableTarget\| ..)` | 一行、一个单元格或一个标题被连按两次：`{ row?, column? }`。 |
| `onContextMenu` | `.on_context_menu(\|event: &DataTableContextMenu\| ..)` | 请求了上下文菜单：`{ row?, column?, x, y }`，位置位于根视图中。 |
| `onSortChange` | `.on_sort_change(\|sort: &Option<DataTableSort>\| ..)` | 按下了排序按钮：下一个排序 `{ key, direction }`，或 `null`。 |
| `onColumnResize` | `.on_column_resize(\|key: &SharedString, width: &Points\| ..)` | 列被调整宽度，拖动的每一步都会触发，适配设置宽度时再触发一次。 |
| `onColumnMove` | `.on_column_move(\|event: &DataTableColumnMove\| ..)` | 列被移动：`{ key, from, to, order }`。 |
| `onVisibleRowsChange` | `.on_visible_rows_change(\|range: &DataTableRange\| ..)` | 视野中的行变了：`{ start, end }`。在这里获取行。 |
| `onVisibleColumnsChange` | `.on_visible_columns_change(\|range: &DataTableRange\| ..)` | 视野中的滚动列变了。 |
| `onLoadMore` | `.on_load_more(\|\| ..)` | 在 `hasMore` 且未 `loading` 时，视野中的行进入了最后一行的 `loadMoreThreshold` 范围内。 |

<a id="related"></a>

## 相关

- [Editor](./editor.md) 和 [DiffView](./diff-view.md)：另外两个处理大量数据的基础组件。
- [Menu](./menu.md)：从 `onContextMenu` 打开的菜单。
- [`nsh/base`](../modules/nsh-base.md)：其他基础组件。
