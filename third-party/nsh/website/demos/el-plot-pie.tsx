import { mount, signal, Text, View } from "nsh";
import { Arc, Pie, Plot } from "nsh/base/plot";
import { desktop, Log, Panel, Segmented, size, Split, tint, ui, wide } from "./palette";

// A donut built from the plot's parts: a `Pie` of the rows' shares, each
// slice in a series color of the theme (`fill-chart-*`, a class per row),
// 2-point gaps between them (the pad is as wide at the hole as at the rim),
// the largest share first, clockwise from 12 o'clock. The slice under the
// pointer lifts and the others fade, natively; its value is in the hole and
// its legend row stands out while the others fade too. The legend's values
// and shares are tabular and at the trailing edge. A breakdown with nothing
// in it keeps a faint ring, an `Arc`, so the chart still reads as one.
type Part = { name: string; revenue: number };
type Breakdown = "Region" | "Channel" | "None";
type Shape = "donut" | "pie";

const BREAKDOWNS: Record<Breakdown, Part[]> = {
  Region: [
    { name: "North America", revenue: 482 },
    { name: "EMEA", revenue: 312 },
    { name: "APAC", revenue: 268 },
    { name: "Latin America", revenue: 104 },
    { name: "Other", revenue: 74 },
  ],
  Channel: [
    { name: "Direct", revenue: 540 },
    { name: "Partners", revenue: 330 },
    { name: "Marketplace", revenue: 250 },
    { name: "Resellers", revenue: 120 },
  ],
  None: [
    { name: "North America", revenue: 0 },
    { name: "EMEA", revenue: 0 },
  ],
};

/** The theme's series colors, as a slice's fill and a legend key's
 * background. */
const FILLS = ["fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-chart-4", "fill-chart-5"];
const KEYS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

const money = (k: number) => (k >= 1000 ? `$${(k / 1000).toFixed(2)}M` : `$${k}k`);
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const num = { fontVariant: ["tabular-nums" as const], textAlign: "right" as const };

function App() {
  const breakdown = signal<Breakdown>("Region");
  const shape = signal<Shape>("donut");
  const hovered = signal<number | null>(null);
  const events = signal<string[]>([]);
  const parts = () => BREAKDOWNS[breakdown()];
  const total = () => parts().reduce((sum, p) => sum + p.revenue, 0);
  const shown = () => {
    const at = hovered();
    return at == null ? undefined : parts()[at];
  };
  const share = (p: Part) => (total() > 0 ? p.revenue / total() : 0);
  // The ring's size: its rim is half of it, the gaps 2 points wide there.
  const ring = desktop ? 200 : 184;
  const donut = () => shape() === "donut";
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>pie</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Move the pointer over a slice to read it" : "Pick a breakdown to draw other slices"}
      </Text>

      <Split
        width={520}
        inspector={
          <>
            <Panel title="shape · data">
              <Segmented options={["donut", "pie"] as const} value={shape()} onChange={(s) => shape.set(s)} />
              <Segmented
                options={["Region", "Channel", "None"] as const}
                value={breakdown()}
                onChange={(b) => (breakdown.set(b), hovered.set(null))}
              />
              <Text style={{ fontSize: 13, color: ui().text }}>
                {`${parts().filter((p) => p.revenue > 0).length} slices · ${money(total())} in all`}
              </Text>
            </Panel>
            <Log title="onHoverChange" lines={events()} minHeight={92} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 14, gap: 16 }}>
          <View class="flex-row items-baseline gap-3">
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: size.label, fontWeight: "600", color: ui().text }}>Revenue</Text>
              <Text style={{ fontSize: size.detail, color: ui().muted }}>{`Q3 2026 · by ${breakdown() === "Channel" ? "channel" : "region"}`}</Text>
            </View>
            <Text style={{ fontSize: 20, fontWeight: "600", color: ui().text, ...num }}>{money(total())}</Text>
          </View>

          <View style={{ flexDirection: wide() ? "row" : "column", alignItems: "center", gap: wide() ? 28 : 18 }}>
            <Plot
              data={parts()}
              accessibilityLabel={
                total() > 0
                  ? `Revenue by ${breakdown().toLowerCase()}, ${money(total())} in all; largest ${parts()[0].name} at ${percent(share(parts()[0]))}`
                  : "Revenue: nothing this quarter"
              }
              accessibilityValue={{ text: shown() && `${shown()!.name}: ${money(shown()!.revenue)}, ${percent(share(shown()!))}` }}
              // Motion of the app's: the ring sweeps in for each breakdown,
              // the hole opens and closes between donut and pie, the slice
              // under the pointer lifts on the spring; reduced motion shows
              // it all at once.
              appearGeneration={["Region", "Channel", "None"].indexOf(breakdown())}
              motion={{ appear: { duration: 900, easing: "easeOut" }, update: { duration: 450, easing: "easeInOut" }, enter: { duration: 120 }, exit: { duration: 180 }, pointer: { stiffness: 420, damping: 40 } }}
              onHoverChange={(index) => {
                hovered.set(index);
                const p = index == null ? undefined : parts()[index];
                const line = p ? `${index}: ${p.name}, ${money(p.revenue)} (${percent(share(p))})` : "null: off the slices";
                events.set([line, ...events()].slice(0, 5));
              }}
              style={{ width: ring, height: ring }}
            >
              {/* Nothing to split: a faint ring keeps the chart's shape. */}
              <If when={total() === 0}>
                <Arc innerRadius={donut() ? "62%" : 0} outerRadius={ring / 2 - 8} style={{ fill: tint(ui().text, 0.06) }} />
              </If>
              <Pie
                value="revenue"
                innerRadius={donut() ? "62%" : 0}
                // The rim 8 points in, room for the lift.
                outerRadius={ring / 2 - 8}
                padAngle={2 / (ring / 2 - 8)}
                sliceClass={(_, i) => FILLS[i % FILLS.length]}
                hoverLift={6}
                hoverDim={0.64}
              />
              {/* The hovered part, or the total, in the hole: it fades with
                  the hole opening and closing. */}
              <View
                class="transition-opacity duration-300 motion-reduce:transition-none"
                pointerEvents="none"
                style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 4, opacity: donut() ? 1 : 0 }}
              >
                <Text style={{ fontSize: size.detail, color: ui().muted }}>{shown()?.name ?? "Total"}</Text>
                <Text style={{ fontSize: 22, fontWeight: "600", color: ui().text, ...num, textAlign: "center" }}>
                  {money(shown()?.revenue ?? total())}
                </Text>
                <Text style={{ fontSize: size.detail, color: ui().muted, ...num, textAlign: "center" }}>
                  {shown() ? percent(share(shown()!)) : `${parts().filter((p) => p.revenue > 0).length} parts`}
                </Text>
              </View>
            </Plot>

            {/* The legend: a key in each slice's color, the value and the
                share at the trailing edge; the hovered part's row stands out. */}
            <View style={{ alignSelf: "stretch", flex: wide() ? 1 : undefined, gap: 2 }}>
              <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 8, paddingBottom: 4 }}>
                <View style={{ width: 8 }} />
                <Text style={{ flex: 1, fontSize: 11, color: ui().faint }}>{breakdown() === "Channel" ? "Channel" : "Region"}</Text>
                <Text style={{ fontSize: 11, color: ui().faint, ...num }}>Revenue</Text>
                <Text style={{ width: 52, fontSize: 11, color: ui().faint, ...num }}>Share</Text>
              </View>
              {parts().map((p, i) => (
                <View
                  class="transition-opacity duration-150 motion-reduce:transition-none"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    height: size.rowSm,
                    paddingHorizontal: 8,
                    borderRadius: 6,
                    backgroundColor: hovered() === i ? tint(ui().text, 0.05) : undefined,
                    opacity: hovered() == null || hovered() === i ? 1 : 0.45,
                  }}
                >
                  <View class={KEYS[i % KEYS.length]} style={{ width: 8, height: 8, borderRadius: 2 }} />
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: size.label - 1, color: ui().text }}>{p.name}</Text>
                  <Text style={{ fontSize: size.label - 1, color: ui().text, ...num }}>{money(p.revenue)}</Text>
                  <Text style={{ width: 52, fontSize: size.label - 1, color: ui().muted, ...num }}>{percent(share(p))}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      </Split>
    </View>
  );
}

mount(App);
