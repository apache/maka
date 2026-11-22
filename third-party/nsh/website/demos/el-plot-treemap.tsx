import { mount, signal, Text, View } from "nsh";
import { Plot, Treemap } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui, sectionSurface, categoryColors } from "./palette";

// A `Treemap` of the plot's rows: each row a node, its `id` and the
// `parent` it names making the tree, each leaf's area its `value` and each
// group's the sum of its leaves'. The squarified tiles go largest first
// from the top left (`sort="value"`), or in the rows' order
// (`sort="data"`); the gaps between siblings are `paddingInner` per level,
// and each group's name sits in a band at its top (`paddingTop`).
//
// The market map colors each stock by its change of the day along a
// diverging `colorScale` (losses red, gains green, flat neutral) and
// centers its ticker on it. The budget has three levels, a line of 0 and
// one below 0, which take no area: a treemap's areas are shares of a
// whole. The node under the pointer (or the arrow keys) is outlined and
// read out, the others fading.
type Node = { id: string; parent?: string; name: string; value?: number; chg?: number };

const MARKET: Node[] = [
  { id: "tech", name: "Technology" },
  { id: "comm", name: "Communication" },
  { id: "fin", name: "Financials" },
  { id: "health", name: "Healthcare" },
  ...(
    [
      ["NVDA", "tech", 4300, 2.4],
      ["MSFT", "tech", 3700, -0.6],
      ["AAPL", "tech", 3600, 0.4],
      ["AVGO", "tech", 1600, 3.1],
      ["ORCL", "tech", 720, -2.8],
      ["AMD", "tech", 380, 1.8],
      ["GOOGL", "comm", 3100, 1.1],
      ["META", "comm", 1800, -1.5],
      ["NFLX", "comm", 480, 0.2],
      ["BRK.B", "fin", 1050, 0.2],
      ["JPM", "fin", 830, 1.3],
      ["V", "fin", 670, -0.3],
      ["GS", "fin", 240, 2.7],
      ["LLY", "health", 820, -1.9],
      ["UNH", "health", 300, -4.1],
      ["JNJ", "health", 460, 0.4],
    ] as const
  ).map(([id, parent, value, chg]) => ({ id, parent, name: id, value, chg })),
];

/** A team's yearly budget in thousands: three levels, a line that is done (0) and one refunded (below 0). */
const BUDGET: Node[] = [
  { id: "eng", name: "Engineering" },
  { id: "ops", name: "Operations" },
  { id: "infra", parent: "eng", name: "Infrastructure" },
  { id: "product", parent: "eng", name: "Product" },
  { id: "cloud", parent: "infra", name: "Cloud", value: 420 },
  { id: "ci", parent: "infra", name: "CI runners", value: 96 },
  { id: "observability", parent: "infra", name: "Observability", value: 74 },
  { id: "salaries", parent: "product", name: "Contractors", value: 310 },
  { id: "design", parent: "product", name: "Design tools", value: 38 },
  { id: "research", parent: "product", name: "User research", value: 0 },
  { id: "office", parent: "ops", name: "Office", value: 180 },
  { id: "travel", parent: "ops", name: "Travel", value: 64 },
  { id: "legal", parent: "ops", name: "Legal", value: -12 },
];

const num = { fontVariant: ["tabular-nums" as const] };
const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
/** A node's value: its own, or its leaves' sum (what the treemap gives `valueLabel`). */
const total = (rows: Node[], id: string): number => {
  const children = rows.filter((r) => r.parent === id);
  if (children.length === 0) return Math.max(0, rows.find((r) => r.id === id)?.value ?? 0);
  return children.reduce((s, c) => s + total(rows, c.id), 0);
};
const path = (rows: Node[], node: Node): string => {
  const parent = node.parent && rows.find((r) => r.id === node.parent);
  return parent ? `${path(rows, parent)} / ${node.name}` : node.name;
};

function App() {
  const chart = signal<"market" | "budget">("market");
  const sort = signal<"value" | "data">("value");
  const hovered = signal<number | null>(null);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 5));
  const rows = () => (chart() === "market" ? MARKET : BUDGET);
  const shown = () => (hovered() == null ? undefined : rows()[hovered()!]);
  const height = desktop ? 260 : 240;
  const motion = { appear: { duration: 800, easing: "easeOut" }, update: { duration: 500, easing: "easeInOut" }, enter: { duration: 120 }, exit: { duration: 160 }, pointer: { stiffness: 380, damping: 36 } } as const;
  const outline = () => ({ borderRadius: 3, outlineWidth: 2, outlineColor: ui().text });
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>plot treemap</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Move the pointer over a tile or a group's name" : "Each tile's area is its share of the whole"}</Text>

      <Split
        width={560}
        inspector={
          <>
            <Panel title="data">
              <Segmented options={["market", "budget"] as const} value={chart()} onChange={(c) => (chart.set(c), hovered.set(null))} />
            </Panel>
            <Panel title="sort">
              <Segmented options={["value", "data"] as const} value={sort()} onChange={(s) => sort.set(s)} />
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...sectionSurface({ padded: true }), gap: 12 }}>
          <View class="flex-row items-baseline gap-3">
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>
                {shown() ? path(rows(), shown()!) : chart() === "market" ? "Largest stocks by sector" : "Budget by team"}
              </Text>
              <Text style={{ fontSize: size.detail, color: ui().muted, ...num }}>
                {chart() === "market" ? "Area: market cap · color: change of the day" : "Thousands of dollars · a line of 0 and a refund take no area"}
              </Text>
            </View>
            <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>
              {shown() ? (chart() === "market" && shown()!.chg != null ? pct(shown()!.chg!) : `$${total(rows(), shown()!.id)}k`) : ""}
            </Text>
          </View>
          <Plot
            data={rows()}
            colorScale={
              chart() === "market"
                ? { type: "diverging", domain: [-3, 3], range: [ui().down, tint(ui().text, 0.1), ui().up] }
                : { type: "ordinal", domain: ["eng", "ops"], range: categoryColors().slice(0, 2) }
            }
            accessibilityLabel={chart() === "market" ? "Market map of 16 stocks in 4 sectors" : "Budget of two teams in three levels"}
            accessibilityValue={{ text: shown() && path(rows(), shown()!) }}
            appearGeneration={chart()}
            motion={motion}
            onHoverChange={({ index }) => {
              hovered.set(index);
              const n = index == null ? undefined : rows()[index];
              log(n == null ? "null: left the map" : `${index}: ${path(rows(), n)}`);
            }}
            style={{ height }}
          >
            <Treemap
              id="id"
              parent="parent"
              value="value"
              sort={sort()}
              colorValue={chart() === "market" ? "chg" : undefined}
              color={chart() === "budget" ? (d: Node) => (d.id === "ops" || d.parent === "ops" ? "ops" : "eng") : undefined}
              paddingInner={chart() === "market" ? [3, 1] : [4, 2, 1]}
              paddingOuter={chart() === "market" ? 0 : [2, 1]}
              paddingTop={18}
              cornerRadii={3}
              stagger={0.4}
              inactiveOpacity={0.35}
              groupClass={chart() === "budget" ? "fill-foreground/5" : undefined}
              label={(d: Node) => d.name}
              valueLabel={(d: Node, value: number) => (d.chg != null ? pct(d.chg) : `$${value}k`)}
              labelPlacement={chart() === "market" ? "center" : "start"}
              labelClass="p-1.5 text-foreground data-dark:text-white"
              labelStyle={{ fontSize: 11, fontWeight: "600" }}
              valueLabelStyle={{ fontSize: 10, fontWeight: "400", opacity: 0.85, ...num }}
              groupLabel="name"
              groupLabelClass="px-1.5 text-muted-foreground"
              groupLabelStyle={{ fontSize: 10.5, lineHeight: 18 }}
              hoverStyle={outline()}
            />
          </Plot>
        </View>
      </Split>
    </View>
  );
}

mount(App);
