// A case of the API's test suite (docs/dev/compatibility.md): `DataTable`
// of `nsh/base`, a table of the rows and columns the app owns (`columns`,
// `data`) of which only the ones in view are drawn. A press on a row
// selects it (`cellSelectable`, reported by `onSelectionChange`, read and
// set through the ref: `selection`, `select`); a sortable column's header
// reports the next sort (`onSortChange`), which the app applies (`sort`).
// `rowCount` and `dataStart` let the app hold a part of the rows only (here
// rows 1 and 2 of five); the ref scrolls to one (`scrollToRow`), the rows
// in view are reported (`onVisibleRowsChange`) and read (`visibleRows`).
// `renderCell` draws a cell the app's way, with the text the table would
// show.
import { Text, View, signal } from "nsh";
import { DataTable, type DataTableRef, type DataTableSort } from "nsh/base";

const columns = [
  { key: "name", title: "Name", width: 120, sortable: true, cellClass: "justify-start", headerClass: "justify-start" },
  { key: "qty", title: "Qty", width: 80, align: "end" as const },
];
const NAMES = ["pear", "apple", "fig"];
const rows = (descending: boolean) => {
  const list = [...NAMES].sort();
  if (descending) list.reverse();
  return list.map((name, i) => ({ name, qty: i + 1 })).slice(1);
};

export default function BaseDataTable() {
  const sort = signal<DataTableSort | undefined>(undefined);
  const selected = signal("none");
  const visible = signal("none");
  const read = signal("none");
  const sorted = signal("none");
  const pressed = signal("none");
  let table!: DataTableRef;
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 390, height: 200 }}>
        <DataTable
          ref={r => (table = r)}
          columns={columns}
          data={rows(sort()?.direction === "descending")}
          rowCount={5}
          dataStart={1}
          bounces={false}
          accessibilityLabel="Fruits"
          cellSelectable
          sort={sort()}
          onSortChange={next => {
            sorted.set(next ? `${next.key} ${next.direction}` : "cleared");
            sort.set(next ?? undefined);
          }}
          onSelectionChange={s => selected.set(s ? `row ${s.row} column ${s.column}` : "none")}
          onRowPress={e => pressed.set(`${e.row}:${e.column} ${e.clicks}`)}
          onVisibleRowsChange={r => visible.set(`${r.start}-${r.end}`)}
          renderCell={cell => <Text>{`Cell ${cell.row}:${cell.key} ${cell.text}`}</Text>}
          style={{ flex: 1 }}
        />
      </View>
      <Text>{() => `Selected: ${selected()}`}</Text>
      <Text>{() => `Sorted: ${sorted()}`}</Text>
      <Text>{() => `Pressed: ${pressed()}`}</Text>
      <Text>{() => `Visible: ${visible()}`}</Text>
      <Text>{() => `Read: ${read()}`}</Text>
      <View testID="select" style={{ height: 20 }} onPress={() => table.select({ row: 2, column: 1 })} />
      <View
        testID="read"
        style={{ height: 20 }}
        onPress={async () => {
          const s = await table.selection();
          const v = await table.visibleRows();
          read.set(`${s?.row}:${s?.column} ${v.start}-${v.end}`);
        }}
      />
      <View testID="scroll" style={{ height: 20 }} onPress={() => table.scrollToRow(2)} />
    </View>
  );
}
