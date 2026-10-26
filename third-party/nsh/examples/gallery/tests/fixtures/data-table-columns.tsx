import { mount, signal, Text, View } from "nsh";
import { DataTable } from "nsh/base";

const rows = [
  { name: "Ada", note: "a much longer text than the width" },
  { name: "Alan", note: "short" },
];

function App() {
  const widths = signal("");
  // What the app's drawing adds to the note's text (an icon), for fits.
  const padding = signal<number | undefined>(undefined);
  const columns = () => [
    { key: "name", title: "Name", width: 100, cellClass: "justify-end", headerClass: "justify-end" },
    { key: "note", title: "Note", width: 80, fitPadding: padding() },
  ];
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text>{() => `widths ${widths()}`}</Text>
      <View testID="pad" style={{ width: 20, height: 20 }} onPress={() => padding.set(40)} />
      <View style={{ width: 560, height: 200 }}>
        <DataTable
          testID="table"
          columns={columns()}
          data={rows}
          rowCount={rows.length}
          onColumnResize={(key, width) => widths.set(`${key}=${Math.round(width)}`)}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

mount(App);
