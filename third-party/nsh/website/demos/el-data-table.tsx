import { mount, signal, Text, View } from "nsh";
import { DataTable, type DataTableColumn, type DataTableSelection, type DataTableSort } from "nsh/base";
import { dataTableClasses, dataTableFitPadding, Log, Segmented, Split, ui, wide } from "./palette";

const NAMES = ["Ada", "Alan", "Grace", "Linus", "Margaret", "Dennis", "Barbara", "Ken"];
const CITIES = ["Oslo", "Lima", "Kyoto", "Cairo", "Perth", "Quito", "Turin", "Hanoi"];

type Person = { id: number; name: string; city: string; score: number };

const people: Person[] = Array.from({ length: 2000 }, (_, i) => ({
  id: i + 1,
  name: `${NAMES[i % NAMES.length]} ${i + 1}`,
  city: CITIES[(i * 7) % CITIES.length],
  score: (i * 37) % 1000,
}));

const columns: DataTableColumn[] = [
  { key: "id", title: "ID", width: 70, align: "end", fixed: true, sortable: true },
  { key: "name", title: "Name", width: 150, sortable: true },
  { key: "city", title: "City", width: 120, sortable: true },
  { key: "score", title: "Score", width: 90, align: "end", sortable: true },
];

// Sorting is the app's: the table reports the next sort (`onSortChange`),
// the app orders its rows and sets `sort`.
function App() {
  const mode = signal<"row" | "cell">("row");
  const sort = signal<DataTableSort | undefined>(undefined);
  const rows = signal<Person[]>(people);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));

  const sortBy = (next: DataTableSort | undefined) => {
    sort.set(next);
    if (!next) return rows.set(people);
    const key = next.key as keyof Person;
    const sign = next.direction === "descending" ? -1 : 1;
    rows.set([...people].sort((a, b) => (a[key] < b[key] ? -sign : a[key] > b[key] ? sign : 0)));
  };

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>data table</Text>
      <Text style={{ color: ui().muted }}>Press a title to sort, drag its edge to resize or the title to move it</Text>

      <Split
        grow
        width={680}
        inspector={
          <>
            <Segmented label="selection" options={["row", "cell"] as const} value={mode()} onChange={(v) => mode.set(v)} />
            <Log title="events" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 360 : 320, ...ui().card, borderRadius: 14, overflow: "hidden" }}>
          <DataTable
            columns={columns.map((column) => ({ ...column, fitPadding: dataTableFitPadding }))}
            classes={dataTableClasses}
            data={rows()}
            rowHeader={false}
            stripe
            cellSelectable={mode() === "cell"}
            sort={sort()}
            onSortChange={(next) => {
              sortBy(next ?? undefined);
              log(`onSortChange: ${next ? `${next.key} ${next.direction}` : "none"}`);
            }}
            onSelectionChange={(s: DataTableSelection | null) => log(`onSelectionChange: ${s ? JSON.stringify(s) : "none"}`)}
            onColumnResize={(key, width) => log(`onColumnResize: ${key} ${Math.round(width)}`)}
            style={{ flex: 1 }}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
