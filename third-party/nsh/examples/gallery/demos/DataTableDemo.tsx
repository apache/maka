import { cleanup, signal, Text, View } from "nsh";
import { Button, DataTable, type DataTableColumn, type DataTableRef, type DataTableSelection, type DataTableSort } from "nsh/base";
import { dataTableClasses, dataTableFitPadding, Segmented } from "../ui";

// `nsh/base`'s `DataTable` over a million stocks of sixty columns the app
// does not hold, with live quotes as gpui-component's data table story: a
// tick every 33 ms moves a third of the quotes in view. The table asks for
// the rows in view (`onVisibleRowsChange`) and the app formats those (and a
// reach around them) and hands them over (`data`, `dataStart`, `rowCount`),
// so a scroll or a tick costs what is on screen, whatever the number of
// rows. Rises and falls take their colors natively (`positiveClass`,
// `negativeClass`), with no call into JS per cell. Sorting is the app's: it
// reports the next sort (`onSortChange`), the app orders what it serves and
// sets `sort`.

const ROWS = 1_000_000;
const TICK_MS = 33;
// The rows formatted and held: those in view and a reach around them. A
// scroll serves another page only when the rows in view come within
// `MARGIN` of its edge.
const PAGE = 120;
const MARGIN = 10;
const INDICATORS = 39;
const COUNTERS = [
  ["AAPL", "Apple", "US"],
  ["MSFT", "Microsoft", "US"],
  ["NVDA", "NVIDIA", "US"],
  ["TSLA", "Tesla", "US"],
  ["AMZN", "Amazon", "US"],
  ["GOOG", "Alphabet", "US"],
  ["META", "Meta", "US"],
  ["0700.HK", "Tencent", "HK"],
  ["9988.HK", "Alibaba", "HK"],
  ["3690.HK", "Meituan", "HK"],
  ["1810.HK", "Xiaomi", "HK"],
  ["600519.SH", "Moutai", "CN"],
  ["300750.SZ", "CATL", "CN"],
  ["D05.SI", "DBS", "SG"],
] as const;

// A stock's numbers, by field.
const F = {
  price: 0,
  change: 1,
  percent: 2,
  volume: 3,
  turnover: 4,
  cap: 5,
  ttm: 6,
  bid: 7,
  bidVolume: 8,
  ask: 9,
  askVolume: 10,
  open: 11,
  prevClose: 12,
  high: 13,
  low: 14,
  shares: 15,
  ratio: 16,
  ranking: 17,
} as const;
const FIELDS = 18;

const compact = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
};
const signed = (v: number, digits = 2, unit = "") => `${v > 0 ? "+" : ""}${v.toFixed(digits)}${unit}`;

/** A number in [0, 1) fixed by `id` and `k`: a stock's quote before it ticks. */
function hash(id: number, k: number): number {
  let x = (Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Sets a quote from `r` (random numbers in [0, 1), by field). */
function quote(n: Float64Array, r: (k: number) => number) {
  const percent = (r(0) - 0.5) * 0.2;
  const price = 5 + r(1) * 994;
  n[F.price] = price;
  n[F.percent] = percent;
  n[F.change] = price * percent;
  n[F.prevClose] = price - n[F.change];
  n[F.volume] = 1e4 + r(2) * 5e7;
  n[F.turnover] = n[F.volume] * price;
  n[F.cap] = price * n[F.shares];
  n[F.ttm] = 5 + r(3) * 75;
  n[F.bid] = price * (1 - r(4) * 0.01);
  n[F.bidVolume] = 100 + r(5) * 5e4;
  n[F.ask] = price * (1 + r(6) * 0.01);
  n[F.askVolume] = 100 + r(7) * 5e4;
  n[F.ratio] = n[F.bidVolume] / n[F.askVolume];
  n[F.high] = price * (1 + r(8) * 0.08);
  n[F.low] = price * (1 - r(9) * 0.08);
  n[F.ranking] = 1 + r(10) * 100;
}

/** Stock `id`'s quote as it opened: the same every time it is asked. */
function opening(id: number): Float64Array {
  const n = new Float64Array(FIELDS);
  n[F.shares] = 1e8 + hash(id, 20) * 1e10;
  n[F.open] = 5 + hash(id, 21) * 994;
  quote(n, (k) => hash(id, k));
  return n;
}

const right = { align: "end" as const, width: 110 };
const tone = { positiveClass: "text-green-600", negativeClass: "text-red-600" };
const columns: DataTableColumn[] = [
  { key: "id", title: "ID", width: 90, align: "end" as const, fixed: true, sortable: true },
  { key: "symbol", title: "Symbol", width: 110, fixed: true },
  { key: "name", title: "Name", width: 150 },
  { key: "market", title: "Market", width: 80 },
  { key: "price", title: "Price", ...right },
  { key: "change", title: "Chg", ...right, ...tone },
  { key: "percent", title: "Chg%", ...right, ...tone },
  { key: "volume", title: "Volume", ...right },
  { key: "turnover", title: "Turnover", ...right },
  { key: "cap", title: "Market Cap", ...right },
  { key: "ttm", title: "TTM", ...right },
  { key: "bid", title: "Bid", ...right },
  { key: "bidVolume", title: "Bid Vol", ...right },
  { key: "ask", title: "Ask", ...right },
  { key: "askVolume", title: "Ask Vol", ...right },
  { key: "open", title: "Open", ...right },
  { key: "prevClose", title: "Prev Close", ...right },
  { key: "high", title: "High", ...right },
  { key: "low", title: "Low", ...right },
  { key: "ratio", title: "Bid/Ask", ...right },
  { key: "ranking", title: "5m Ranking", ...right },
  ...Array.from({ length: INDICATORS }, (_, i) => ({
    key: `x${i + 1}`,
    title: `Indicator ${i + 1}`,
    ...right,
    ...tone,
  })),
].map((column) => ({ ...column, fitPadding: dataTableFitPadding }));

/** The cells of stock `id`'s row with quote `n`, in the columns' order. */
function row(id: number, n: Float64Array): (string | number)[] {
  const [symbol, name, market] = COUNTERS[id % COUNTERS.length];
  const out: (string | number)[] = [
    id + 1,
    symbol,
    `${name} ${id + 1}`,
    market,
    n[F.price].toFixed(2),
    signed(n[F.change]),
    signed(n[F.percent] * 100, 2, "%"),
    compact(n[F.volume]),
    compact(n[F.turnover]),
    compact(n[F.cap]),
    n[F.ttm].toFixed(2),
    n[F.bid].toFixed(2),
    compact(n[F.bidVolume]),
    n[F.ask].toFixed(2),
    compact(n[F.askVolume]),
    n[F.open].toFixed(2),
    n[F.prevClose].toFixed(2),
    n[F.high].toFixed(2),
    n[F.low].toFixed(2),
    n[F.ratio].toFixed(2),
    n[F.ranking].toFixed(1),
  ];
  // Indicators move with the change, each by a share of its own.
  for (let i = 0; i < INDICATORS; i++) {
    out.push(signed(n[F.percent] * 100 * (i % 2 ? 1 : -1) * (0.25 + (i % 7) * 0.2), 2, "%"));
  }
  return out;
}

/** A small button in the gallery's look. */
function Tool(props: { label: string; name: string; onPress: () => void }) {
  return (
    <Button
      onPress={props.onPress}
      accessibilityLabel={props.label}
      class="h-8 items-center justify-center rounded-md border border-border bg-card px-3 active:opacity-70"
    >
      <Text class="text-[13px] font-semibold text-foreground">{props.name}</Text>
    </Button>
  );
}

/**
 * DataTable: a million stocks of sixty columns whose quotes in view tick
 * every 33 ms, the ID and Symbol columns fixed at the left, the ID column
 * sortable, rows, cells or columns selected, columns resized and moved.
 */
export function DataTableDemo() {
  const mode = signal<"row" | "cell">("row");
  const sort = signal<DataTableSort | undefined>(undefined);
  const page = signal<{ start: number; rows: (string | number)[][] }>({ start: 0, rows: [] });
  const selection = signal<DataTableSelection | null>(null);
  const visible = signal({ start: 0, end: 0 });
  const stripe = signal(true);
  const live = signal(true);
  const ticks = signal(0);
  let table: DataTableRef | undefined;
  let around = { start: 0, end: 40 };
  // The quotes that ticked, by stock: those of the page held. The others
  // show how they opened.
  const quotes = new Map<number, Float64Array>();

  const descending = () => sort()?.key === "id" && sort()?.direction === "descending";
  const stockAt = (at: number) => (descending() ? ROWS - 1 - at : at);
  const quoteOf = (id: number) => quotes.get(id) ?? opening(id);

  // The page around the rows in view: the rows the page held keep their
  // cells, the others are formatted (all of them when `fresh`, the order
  // changed).
  const serve = (fresh = false) => {
    const span = around.end - around.start;
    const start = Math.max(0, Math.min(ROWS - PAGE, Math.floor(around.start - (PAGE - span) / 2)));
    const held = page();
    const rows = [];
    for (let at = start; at < Math.min(ROWS, start + PAGE); at++) {
      const kept = fresh ? undefined : held.rows[at - held.start];
      if (kept) {
        rows.push(kept);
        continue;
      }
      const id = stockAt(at);
      rows.push(row(id, quoteOf(id)));
    }
    page.set({ start, rows });
    // Far scrolls leave ticked quotes behind: those off the page go back
    // to how they opened, so the app holds what is near the view only.
    for (const id of quotes.keys()) {
      const at = descending() ? ROWS - 1 - id : id;
      if (at < start || at >= start + PAGE) quotes.delete(id);
    }
  };

  // The rows in view near the page's edge (and not at the table's): serve
  // the page around them.
  const follow = () => {
    const held = page();
    const end = held.start + held.rows.length;
    const nearStart = held.start > 0 && around.start < held.start + MARGIN;
    const nearEnd = end < ROWS && around.end > end - MARGIN;
    if (nearStart || nearEnd || around.start < held.start || around.end > end) serve();
  };

  const step = () => {
    if (!live()) return;
    // A third of the rows held move, as in gpui-component's story, and
    // only those are formatted again; the rest of the stocks wait to be
    // shown.
    const held = page();
    const rows = held.rows.slice();
    for (let i = 0; i < rows.length; i++) {
      const at = held.start + i;
      if (at % (3 + Math.floor(Math.random() * 7)) !== 0) continue;
      const id = stockAt(at);
      let n = quotes.get(id);
      if (!n) {
        n = opening(id);
        quotes.set(id, n);
      }
      quote(n, Math.random);
      rows[i] = row(id, n);
    }
    page.set({ start: held.start, rows });
    ticks.set(ticks() + 1);
  };
  const timer = setInterval(step, TICK_MS);
  cleanup(() => clearInterval(timer));
  serve();

  const describe = () => {
    const s = selection();
    if (!s) return "Nothing selected";
    if (s.row != null && s.column != null) return `Cell row ${s.row + 1}, ${columns[s.column].title}`;
    if (s.row != null) return `Row ${s.row + 1}`;
    return `Column ${columns[s.column ?? 0].title}`;
  };

  return (
    <View class="flex-1 gap-3 bg-background p-4">
      <View class="flex-row flex-wrap items-center gap-3">
        <View class="w-[260px]">
          <Segmented
            options={[
              { value: "row", label: "Rows" },
              { value: "cell", label: "Cells" },
            ]}
            value={mode()}
            onChange={(value) => {
              mode.set(value);
              selection.set(null);
            }}
            size="small"
          />
        </View>
        <Tool label="Toggle live updates" name={live() ? "Live on" : "Live off"} onPress={() => live.set(!live())} />
        <Tool label="Toggle stripes" name={stripe() ? "Stripes on" : "Stripes off"} onPress={() => stripe.set(!stripe())} />
        <Tool label="Go to row 500000" name="Row 500,000" onPress={() => table?.scrollToRow(499_999)} />
        <Tool label="Go to Indicator 30" name="Indicator 30" onPress={() => table?.scrollToColumn("x30")} />
      </View>
      <View class="flex-row items-center gap-3">
        <Text class="font-mono text-[12px] text-foreground">{describe()}</Text>
        <Text class="font-mono text-[12px] text-muted-foreground">
          {`rows ${visible().start + 1}–${visible().end} of ${ROWS.toLocaleString("en-US")}`}
        </Text>
        <Text class="font-mono text-[12px] text-muted-foreground">{`${columns.length} columns · tick ${ticks()}`}</Text>
      </View>
      <DataTable
        ref={(r) => (table = r)}
        testID="table"
        class="flex-1"
        classes={dataTableClasses}
        columns={columns}
        data={page().rows}
        dataStart={page().start}
        rowCount={ROWS}
        rowHeight={28}
        fontSize={13}
        stripe={stripe()}
        rowHeader={false}
        cellSelectable={mode() === "cell"}
        sort={sort()}
        onSortChange={(next) => {
          sort.set(next ?? undefined);
          quotes.clear();
          serve(true);
        }}
        onSelectionChange={(next) => selection.set(next)}
        onVisibleRowsChange={(range) => {
          visible.set(range);
          around = range;
          follow();
        }}
      />
    </View>
  );
}
