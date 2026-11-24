// A case of the API's test suite (docs/dev/compatibility.md): a
// `DataTable` activates the focused row with Enter / Return
// (`onRowActivate({ row })`), reporting the row the way `onRowPress`
// does. A press selects a cell and gives the table the keyboard; the
// arrows move the selection and the key activates the row it moved to.
import { Text, View, signal } from "nsh";
import { DataTable } from "nsh/base";

const columns = [
  { key: "name", title: "Name", width: 120 },
  { key: "qty", title: "Qty", width: 80, align: "end" as const },
];
const rows = [
  { name: "pear", qty: 1 },
  { name: "apple", qty: 2 },
];

export default function BaseDataTableActivate() {
  const activated = signal("none");
  return (
    <View style={{ paddingTop: 20 }}>
      <View style={{ width: 390, height: 160 }}>
        <DataTable
          columns={columns}
          data={rows}
          rowHeader={false}
          cellSelectable
          accessibilityLabel="Activate"
          onRowActivate={({ row }) => activated.set(row.toString())}
          style={{ flex: 1 }}
        />
      </View>
      <Text>{() => `Activated: ${activated()}`}</Text>
    </View>
  );
}
