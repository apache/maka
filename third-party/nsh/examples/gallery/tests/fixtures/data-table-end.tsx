import { mount, signal, Text, View } from "nsh";
import { DataTable, type DataTableColumn, type DataTableRef } from "nsh/base";

const ROWS = Array.from({ length: 20 }, (_, i) => ({
  name: `Name ${i}`,
  a: `A ${i}`,
  b: `B ${i}`,
  c: `C ${i}`,
  d: `D ${i}`,
  act: `Act ${i}`,
}));

// Wider than the table: the scrolling columns pass between Name, fixed at
// the start, and Act, fixed at the end.
function App() {
  const log = signal("none");
  let table!: DataTableRef;
  const columns: DataTableColumn[] = [
    { key: "name", title: "Name", width: 100, fixed: true },
    { key: "a", title: "A", width: 150 },
    { key: "b", title: "B", width: 150 },
    { key: "act", title: "Act", width: 80, fixed: "right" },
    { key: "c", title: "C", width: 150 },
    { key: "d", title: "D", width: 150 },
  ];
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text>{`log=${log()}`}</Text>
      <View testID="to-d" style={{ width: 8, height: 8 }} onPress={() => table.scrollToColumn("d")} />
      <View style={{ width: 400, flex: 1 }}>
        <DataTable
          ref={table}
          columns={columns}
          data={ROWS}
          style={{ flex: 1 }}
          onRowPress={(e) => log.set(`${e.row}:${e.column ?? "-"}`)}
        />
      </View>
    </View>
  );
}

mount(App);
