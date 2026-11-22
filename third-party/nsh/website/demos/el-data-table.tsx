import { mount, platform, signal, Text, View } from "nsh";
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnPress,
  type DataTablePress,
  type DataTableSort,
} from "nsh/base";
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

type PickCell = { row: number; column: number };
type AppPick =
  | { kind: "rows"; anchor: number; rows: number[] }
  | { kind: "cells"; anchor: PickCell; cells: PickCell[] }
  | { kind: "columns"; anchor: number; columns: number[] };

function commandHeld(event: { control: boolean; platform: boolean }) {
  return platform.os === "macos" || platform.os === "ios" ? event.platform : event.control;
}

function cellBlock(from: PickCell, to: PickCell): PickCell[] {
  const cells: PickCell[] = [];
  for (let row = Math.min(from.row, to.row); row <= Math.max(from.row, to.row); row++) {
    for (let column = Math.min(from.column, to.column); column <= Math.max(from.column, to.column); column++) {
      cells.push({ row, column });
    }
  }
  return cells;
}

function indexRun(from: number, to: number): number[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function withoutIndex(list: number[], index: number): number[] | null {
  const next = list.filter((item) => item !== index);
  if (next.length !== list.length) return next.length ? next : null;
  return [...list, index];
}

// Sorting is the app's: the table reports the next sort (`onSortChange`),
// the app orders its rows and sets `sort`.
function App() {
  const mode = signal<"row" | "cell">("row");
  const several = signal(false);
  const sort = signal<DataTableSort | undefined>(undefined);
  const rows = signal<Person[]>(people);
  const pick = signal<AppPick | null>(null);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 4));
  const onRowPress = (event: DataTablePress) => {
    log(`onRowPress: row ${event.row} column ${event.column ?? "-"}`);
    if (!several()) return;
    const current = pick();
    if (mode() === "cell" && event.column != null) {
      const cell = { row: event.row, column: event.column };
      if (event.shift && current?.kind === "cells") {
        pick.set({ kind: "cells", anchor: current.anchor, cells: cellBlock(current.anchor, cell) });
      } else if (commandHeld(event) && current?.kind === "cells") {
        const cells = current.cells.filter((c) => c.row !== cell.row || c.column !== cell.column);
        const next = cells.length === current.cells.length ? [...current.cells, cell] : cells;
        pick.set(next.length ? { kind: "cells", anchor: current.anchor, cells: next } : null);
      } else {
        pick.set({ kind: "cells", anchor: cell, cells: [cell] });
      }
      return;
    }
    if (event.shift && current?.kind === "rows") {
      pick.set({ kind: "rows", anchor: current.anchor, rows: indexRun(current.anchor, event.row) });
    } else if (commandHeld(event) && current?.kind === "rows") {
      const next = withoutIndex(current.rows, event.row);
      pick.set(next ? { kind: "rows", anchor: current.anchor, rows: next } : null);
    } else {
      pick.set({ kind: "rows", anchor: event.row, rows: [event.row] });
    }
  };
  const onColumnPress = (event: DataTableColumnPress) => {
    log(`onColumnPress: column ${event.column}`);
    if (!several()) return;
    const current = pick();
    if (event.shift && current?.kind === "columns") {
      pick.set({
        kind: "columns",
        anchor: current.anchor,
        columns: indexRun(current.anchor, event.column),
      });
    } else if (commandHeld(event) && current?.kind === "columns") {
      const next = withoutIndex(current.columns, event.column);
      pick.set(next ? { kind: "columns", anchor: current.anchor, columns: next } : null);
    } else {
      pick.set({ kind: "columns", anchor: event.column, columns: [event.column] });
    }
  };

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
      <Text style={{ color: ui().muted }}>
        Press a title to sort, drag its edge to resize or the title to move it. Several keeps the app's own rows, cells or
        columns: Shift extends a run of rows, a block of cells or a run of columns, and the command key toggles one
      </Text>

      <Split
        grow
        width={680}
        inspector={
          <>
            <Segmented
              label="selection"
              options={["row", "cell"] as const}
              value={mode()}
              onChange={(v) => {
                mode.set(v);
                pick.set(null);
              }}
            />
            <Segmented
              label="several"
              options={["one", "several"] as const}
              value={several() ? "several" : "one"}
              onChange={(v) => {
                const next = v === "several";
                several.set(next);
                if (!next) pick.set(null);
              }}
            />
            <Log title="events" lines={events()} minHeight={96} />
          </>
        }
      >
        <View style={{ height: wide() ? 360 : 320 }}>
          <DataTable
            columns={columns.map((column, i) => {
              const current = pick();
              const marked = several() && current?.kind === "columns" && current.columns.includes(i);
              const next = { ...column, fitPadding: dataTableFitPadding };
              return marked ? { ...next, headerClass: "bg-primary/10", cellClass: "bg-primary/10" } : next;
            })}
            classes={dataTableClasses}
            data={rows()}
            rowHeader={false}
            stripe
            rowSelectable={!several()}
            columnSelectable={!several()}
            cellSelectable={!several() && mode() === "cell"}
            selectOnModifierPress={!several()}
            rowClasses={(() => {
              const current = pick();
              if (!several() || current?.kind !== "rows") return [];
              const chosen = new Set(current.rows);
              return rows().map((_, i) => (chosen.has(i) ? "bg-primary/15" : ""));
            })()}
            cellClasses={(() => {
              const current = pick();
              return several() && current?.kind === "cells"
                ? current.cells.map((cell) => ({ ...cell, class: "bg-primary/15" }))
                : [];
            })()}
            sort={sort()}
            onSortChange={({ sort: next }) => {
              sortBy(next ?? undefined);
              log(`onSortChange: ${next ? `${next.key} ${next.direction}` : "none"}`);
            }}
            onSelectionChange={({ selection }) => log(`onSelectionChange: ${selection ? JSON.stringify(selection) : "none"}`)}
            onRowPress={onRowPress}
            onColumnPress={onColumnPress}
            onColumnResize={({ key, width }) => log(`onColumnResize: ${key} ${Math.round(width)}`)}
            style={{ flex: 1 }}
          />
        </View>
      </Split>
    </View>
  );
}

mount(App);
