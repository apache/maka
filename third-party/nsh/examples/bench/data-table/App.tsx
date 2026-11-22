import { mount, signal } from "nsh";
import { DataTable, type DataTableColumn } from "nsh/base";

// The DataTable scroll workload: 100 000 rows × 20 columns, the app serving
// the rows around those in view (`onVisibleRowsChange`), as an app over
// more rows than a prop takes (a million values) does.

const ROWS = 100_000;
const COLS = 20;
const PAGE = 200;
const columns: DataTableColumn[] = Array.from({ length: COLS }, (_, i) => ({
  key: `c${i}`,
  title: `Column ${i}`,
  width: i === 0 ? 80 : 110,
  fixed: i === 0,
  align: i === 0 ? "start" : "end",
}));
const row = (r: number) =>
  Array.from({ length: COLS }, (_, c) => (c === 0 ? `#${r}` : ((r * 31 + c * 17) % 10007) / 100));

function App() {
  const page = signal({ start: 0, rows: Array.from({ length: PAGE }, (_, r) => row(r)) });
  return (
    <DataTable
      testID="table"
      columns={columns}
      rowCount={ROWS}
      dataStart={page().start}
      data={page().rows}
      onVisibleRowsChange={({ range: v }) => {
        const held = page();
        if (v.start >= held.start && v.end <= held.start + held.rows.length) return;
        const start = Math.max(0, Math.min(ROWS - PAGE, v.start - PAGE / 4));
        page.set({ start, rows: Array.from({ length: PAGE }, (_, i) => row(start + i)) });
      }}
      style={{ flexGrow: 1 }}
    />
  );
}

mount(() => <App />);
