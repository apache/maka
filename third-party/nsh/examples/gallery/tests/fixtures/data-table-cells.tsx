import { mount, signal, Text, View } from "nsh";
import { DataTable, type DataTableColumn } from "nsh/base";

const ROWS = Array.from({ length: 20 }, (_, i) => ({ name: `Person ${i}`, action: "" }));

// A column whose cells hold a button of the app's own, among plain ones.
function App() {
  const log = signal<string[]>([]);
  const put = (line: string) => log.set([...log(), line]);
  const columns: DataTableColumn[] = [
    { key: "name", title: "Name", width: 160 },
    { key: "action", title: "Action", width: 120 },
  ];
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text testID="log">{`log=${log().join(",")}`}</Text>
      <DataTable
        columns={columns}
        data={ROWS}
        style={{ flex: 1 }}
        onRowPress={(e) => put(`row ${e.row}:${e.column ?? "-"}`)}
        renderCell={(cell) =>
          cell.key === "action" ? (
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
              <View
                testID={`copy-${cell.row}`}
                style={{ width: 40, height: 20 }}
                onPress={() => put(`copy ${cell.row}`)}
              >
                <Text>Copy</Text>
              </View>
            </View>
          ) : (
            <Text>{cell.text}</Text>
          )
        }
      />
    </View>
  );
}

mount(App);
