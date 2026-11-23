import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { DataTable, type DataTableColumn, type DataTableRef } from "nsh/base";

// Columns that grow into the table's free width and fit their content when
// their rows come, for `data-table-fit-grow.test.tsx`.

const ROWS = [
  { id: 1, name: "Ada", email: "ada.lovelace@analytical.engine" },
  { id: 2, name: "Alan", email: "alan@bletchley.park" },
];
const LONGER = [...ROWS, { id: 3, name: "Grace", email: "grace.brewster.murray.hopper@navy.mil" }];

function App() {
  const width = signal(560);
  const rows = signal<typeof ROWS>([]);
  const keys = signal("a");
  const log = signal<Record<string, string>>({});
  const put = (key: string, value: string) => log.set({ ...log(), [key]: value });
  let table!: DataTableRef;

  const columns = (): DataTableColumn[] => [
    { key: `id${keys()}`, title: "ID", width: 80 },
    { key: `name${keys()}`, title: "Name", width: 80, grow: 1 },
    { key: `email${keys()}`, title: "Email", width: 80, grow: 3, autoFit: true },
  ];
  const button = (id: string, onPress: () => void) => (
    <View testID={id} style={{ width: 8, height: 8 }} onPress={onPress} />
  );

  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <View style={{ flexDirection: "row" }}>
        {button("load", () => rows.set(ROWS))}
        {button("longer", () => rows.set(LONGER))}
        {button("narrow", () => width.set(400))}
        {button("tiny", () => width.set(200))}
        {button("new-keys", () => keys.set(keys() === "a" ? "b" : "a"))}
        {button("set-width", () => table.setColumnWidth(`name${keys()}`, 100))}
        {button("fit", async () => put("fit", `${Math.round(await table.fitColumn(`email${keys()}`))}`))}
        {button("widths", async () => put("widths", (await table.columnWidths()).map(Math.round).join(",")))}
      </View>
      <Text>{() => Object.entries(log()).map(([k, v]) => `${k}=${v}`).join(" ")}</Text>
      <View style={{ width: width(), height: 200 }}>
        <DataTable
          ref={table}
          testID="table"
          columns={columns()}
          data={rows().map((r) => ({ [`id${keys()}`]: r.id, [`name${keys()}`]: r.name, [`email${keys()}`]: r.email }))}
          rowCount={rows().length}
          rowHeader={false}
          onColumnResize={({ key, width }) => put("resize", `${key.replace(/[ab]$/, "")}:${Math.round(width)}`)}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
