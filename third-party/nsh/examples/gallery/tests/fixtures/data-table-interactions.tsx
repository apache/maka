import { mount, signal, Text, View } from "nsh";
import { DataTable, type DataTableColumn, type DataTableRef, type DataTableSort } from "nsh/base";

// Every interaction of `DataTable` for `data-table-interactions.test.tsx`:
// switches for its props, its events written out, buttons for its ref.

const CITIES = ["Oslo", "Lima", "Kyoto", "Cairo"];
const ALL = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  name: `Person ${i}`,
  city: CITIES[i % CITIES.length],
  change: i % 3 === 0 ? -i : i * 10,
  note: `note ${i}`,
}));

function App() {
  const cells = signal(false);
  const rows = signal(true);
  const cols = signal(true);
  const header = signal<boolean | undefined>(undefined);
  const loop = signal(false);
  const empty = signal(false);
  const loading = signal(false);
  const more = signal(false);
  const movable = signal(true);
  const vbar = signal<boolean | undefined>(undefined);
  const hbar = signal<boolean | undefined>(undefined);
  const sort = signal<DataTableSort | undefined>(undefined);
  const log = signal<Record<string, string>>({});
  const put = (key: string, value: string) => log.set({ ...log(), [key]: value });
  let table!: DataTableRef;

  const columns: DataTableColumn[] = [
    { key: "id", title: "ID", width: 60, fixed: true, sortable: true, align: "end" },
    { key: "name", title: "Name", width: 120, sortable: true, minWidth: 80, maxWidth: 300 },
    { key: "city", title: "City", width: 90, headerClass: "underline", cellClass: "italic" },
    {
      key: "change",
      title: "Change",
      width: 90,
      align: "end",
      positiveClass: "text-green-600",
      negativeClass: "text-red-600",
    },
    { key: "note", title: "Note", width: 120, selectable: false, resizable: false, movable: false },
  ];
  const data = () => {
    if (empty()) return [];
    const list = [...ALL];
    const s = sort();
    if (s) list.sort((a, b) => (s.direction === "ascending" ? 1 : -1) * (a.id - b.id));
    return list;
  };
  const button = (id: string, onPress: () => void) => (
    <View testID={id} style={{ width: 8, height: 8 }} onPress={onPress} />
  );

  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {button("cells", () => cells.set(!cells()))}
        {button("rows", () => rows.set(!rows()))}
        {button("cols", () => cols.set(!cols()))}
        {button("no-header", () => header.set(false))}
        {button("loop", () => loop.set(!loop()))}
        {button("empty", () => empty.set(!empty()))}
        {button("loading", () => loading.set(!loading()))}
        {button("more", () => more.set(!more()))}
        {button("fixed-moves", () => movable.set(!movable()))}
        {button("select-3", () => table.select({ row: 3 }))}
        {button("to-note", () => table.scrollToColumn("note"))}
        {button("to-row-50", () => table.scrollToRow(50))}
        {button("set-width", () => table.setColumnWidth("name", 200))}
        {button("fit", async () => put("fit", `${Math.round((await table.fitColumn("city"))!)}`))}
        {button("widths", async () => put("widths", (await table.columnWidths()).map(Math.round).join(",")))}
        {button("dump", async () => {
          const d = await table.dump(0, 2);
          put("dump", `${d.headers.join("|")} / ${d.rows.map((r) => r.join("|")).join(" / ")}`);
        })}
        {button("copy", () => table.copy())}
        {button("menu-target", async () => {
          const t = await table.menuTarget();
          put("target", t ? `${t.row ?? "-"}:${t.column ?? "-"}` : "none");
        })}
        {button("clear-target", () => table.clearMenuTarget())}
        {button("no-vbar", () => vbar.set(false))}
        {button("no-hbar", () => hbar.set(false))}
        {button("read", async () => {
          const s = await table.selection();
          const v = await table.visibleRows();
          const c = await table.visibleColumns();
          put("read", `${s ? `${s.row}:${s.column}` : "none"} rows ${v.start}-${v.end} cols ${c.start}-${c.end}`);
        })}
      </View>
      <Text>{() => Object.entries(log()).map(([k, v]) => `${k}=${v}`).join("; ") || "log empty"}</Text>
      <View style={{ width: 380, height: 300 }}>
        <DataTable
          ref={(r) => (table = r)}
          testID="t"
          accessibilityLabel="People"
          columns={columns}
          data={data()}
          rowClasses={data().map((r) => (r.id % 5 === 0 ? "line-through" : ""))}
          groups={[[{ label: "Who", span: 2 }, { label: "Where", span: 1 }, { label: "Numbers", span: 2 }]]}
          sort={sort()}
          cellSelectable={cells()}
          rowSelectable={rows()}
          columnSelectable={cols()}
          rowHeader={header()}
          loopSelection={loop()}
          loading={loading()}
          hasMore={more()}
          loadMoreThreshold={5}
          movableColumns={movable()}
          verticalScrollbar={vbar()}
          horizontalScrollbar={hbar()}
          empty={<Text>No rows</Text>}
          loadingView={<Text>Loading rows</Text>}
          onSelectionChange={(s) => put("sel", s ? `${s.row ?? "-"}:${s.column ?? "-"}` : "none")}
          onRowPress={(e) => put("press", `${e.row}:${e.column ?? "-"}:${e.clicks}`)}
          onDoublePress={(t) => put("double", `${t.row ?? "-"}:${t.column ?? "-"}`)}
          onContextMenu={(e) => put("menu", `${e.row ?? "-"}:${e.column ?? "-"}`)}
          onSortChange={(next) => {
            put("sort", next ? `${next.key} ${next.direction}` : "none");
            sort.set(next ?? undefined);
          }}
          onColumnResize={(key, width) => put("resize", `${key} ${Math.round(width)}`)}
          onColumnMove={(e) => put("move", `${e.key} ${e.from}>${e.to} ${e.order.join(",")}`)}
          onVisibleRowsChange={(r) => put("rows", `${r.start}-${r.end}`)}
          onLoadMore={() => put("more", `${Number(log().more ?? 0) + 1}`)}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

mount(App);
