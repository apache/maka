---
title: Table
description: "Table 组件及其部件：由应用自己写出行和单元格的表格，屏幕阅读器将它识别为表格，每个部件的外观由应用决定。"
order: 26.3
group: base
demo: el-table
---

# Table

`Table` 排布应用作为子元素写出的少量行（发票、汇总、对比），并为屏幕阅读器提供表格语义：表格本身、行组、行、列标题和单元格，各有其角色。它的部件有 `TableHeader`、`TableBody` 和 `TableFooter`（行组）、`TableRow`（单元格横向排列）、`TableHead`（列的标题单元格）、`TableCell` 和 `TableCaption`。外观由应用决定：各部件没有自己的颜色、边框、内边距或宽度，都接受应用的 `class` 和 `style`。行数很多、需要排序、选择和可调整宽度的列时，使用 [`DataTable`](./data-table.md)。

```rust tabs
use nsh_base::{table, table_body, table_cell, table_head, table_header, table_row, theme};
use nsh_core::prelude::*;

fn invoices() -> impl IntoElement {
    let cell = |label: &'static str| table_cell().w(px(120.0)).px_3().py_2().child(text(label));
    table()
        .accessibility_label("Recent invoices")
        .child(
            table_header().child(
                table_row()
                    .border_b_1()
                    .border_color(move || theme().border)
                    .child(table_head().w(px(120.0)).px_3().py_2().child(text("Invoice")))
                    .child(table_head().w(px(120.0)).px_3().py_2().child(text("Amount"))),
            ),
        )
        .child(table_body().child(table_row().child(cell("INV001")).child(cell("$250.00"))))
}
```

```tsx tabs
import { mount, Text } from "nsh";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "nsh/base";

function App() {
  return (
    <Table accessibilityLabel="Recent invoices">
      <TableHeader>
        <TableRow class="border-b border-border">
          <TableHead class="w-32 px-3 py-2"><Text>Invoice</Text></TableHead>
          <TableHead class="w-32 px-3 py-2"><Text>Amount</Text></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell class="w-32 px-3 py-2"><Text>INV001</Text></TableCell>
          <TableCell class="w-32 px-3 py-2"><Text>$250.00</Text></TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

mount(App);
```

`Table` 及其部件来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate，由 `table()`、`table_header()`、`table_body()`、`table_footer()`、`table_row()`、`table_head()`、`table_cell()` 和 `table_caption()` 创建，配合类型化的样式方法和 `.child(..)`。行把单元格横向排列；单元格的宽度由应用设置，使各列对齐。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 仅 `Table`：屏幕阅读器对表格的称呼。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 部件包含的内容：`Table` 中的行组和标题说明，行组中的行，行中的单元格，单元格中的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 部件的外观和布局。 |

## 部件

| 部件 | 位于 | 屏幕阅读器中的角色 |
|---|---|---|
| `Table` | | 表格 |
| `TableHeader` | `Table` | 行组：列标题所在的行 |
| `TableBody` | `Table` | 行组：数据行 |
| `TableFooter` | `Table` | 行组：合计、汇总行 |
| `TableRow` | 行组或 `Table` | 行；单元格横向排列 |
| `TableHead` | 表头中的 `TableRow` | 列标题 |
| `TableCell` | `TableRow` | 单元格 |
| `TableCaption` | `Table` | 应用显示的有关表格的内容 |

各平台把这些角色交给自己的屏幕阅读器：Linux（AT-SPI）、Web（ARIA）、Android 和 GPUI 后端使用表格、行、单元格和列标题角色；macOS 和 Windows 使用网格和分组；iOS 把列标题标为标题。

## 另请参阅

- [DataTable](./data-table.md)：行列数量不限的表格，支持选择、排序以及可调整宽度和移动的列。
- [无障碍](../docs/accessibility.md)：`accessibilityRole` 的取值，其中包括 `table`、`row`、`cell`、`columnheader` 和 `rowgroup`。
