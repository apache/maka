// A case of the API's test suite (docs/dev/compatibility.md): `DataTable`
// columns that fit their content once their rows come (`autoFit`) and grow
// into the width the columns leave free (`grow`). The ref's widths
// (`columnWidths`) fill the table's 390 points, and the fitted column is no
// longer the 80 it starts at.
import { Text, View, signal } from "nsh";
import { DataTable, type DataTableRef } from "nsh/base";

const columns = [
  { key: "name", title: "Name", width: 80, autoFit: true },
  { key: "qty", title: "Qty", width: 60, align: "end" as const, grow: 1 },
];
const rows = [
  { name: "a rather long product name", qty: 1 },
  { name: "fig", qty: 2 },
];

export default function BaseDataTableFitGrow() {
  const read = signal("none");
  let table!: DataTableRef;
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 390, height: 160 }}>
        <DataTable ref={r => (table = r)} columns={columns} data={rows} rowHeader={false} style={{ flex: 1 }} />
      </View>
      <Text>{() => `Widths: ${read()}`}</Text>
      <View
        testID="widths"
        style={{ height: 20 }}
        onPress={async () => {
          const [name, qty] = (await table.columnWidths()).map(Math.round);
          read.set(`fill ${name + qty} fitted ${name !== 80}`);
        }}
      />
    </View>
  );
}
