---
title: Table
description: "The Table component and its parts: a table of the app's own rows and cells that screen readers know as a table, with the look the app gives each part."
group: base
demo: el-table
---

# Table

A `Table` lays out a few rows the app writes as children (invoices, a summary, a comparison) and gives screen readers
a table: the table itself, groups of rows, rows, column headers and cells, each with its role. Its parts are
`TableHeader`, `TableBody` and `TableFooter` (groups of rows), `TableRow` (its cells side by side), `TableHead` (a
column's header cell), `TableCell` and `TableCaption`. The look is the app's: no part has colors, borders, paddings or
widths of its own, and each takes the app's `class` and `style`. For many rows, sorting, selection and resizable
columns, [`DataTable`](./data-table.md) is the table.

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

`Table` and its parts come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust, where `table()`,
`table_header()`, `table_body()`, `table_footer()`, `table_row()`, `table_head()`, `table_cell()` and
`table_caption()` make them, with the typed style methods and `.child(..)`. A row lays its cells out side by side; the
app gives cells their widths, so the columns line up.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | `Table` only: what screen readers call the table. |
| `children` | `.child(..)` | `JSX.Element` | none | What the part holds: groups and a caption in a `Table`, rows in a group, cells in a row, content in a cell. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The part's look and layout. |

## Parts

| Part | Inside | Role for screen readers |
|---|---|---|
| `Table` | | table |
| `TableHeader` | `Table` | row group: the rows of column headers |
| `TableBody` | `Table` | row group: the rows of data |
| `TableFooter` | `Table` | row group: totals, a summary row |
| `TableRow` | a group, or `Table` | row; its cells side by side |
| `TableHead` | a `TableRow` of the header | column header |
| `TableCell` | `TableRow` | cell |
| `TableCaption` | `Table` | content the app shows about the table |

Each platform gives the roles to its screen reader: table, row, cell and column header roles on Linux (AT-SPI), the
web (ARIA), Android and the GPUI backend; grids and groups on macOS and Windows; headers as headers on iOS.

## See also

- [DataTable](./data-table.md): a table of any number of rows and columns, with selection, sorting and resizable,
  movable columns.
- [Accessibility](../docs/accessibility.md): the `accessibilityRole` values, `table`, `row`, `cell`, `columnheader` and `rowgroup`
  among them.
