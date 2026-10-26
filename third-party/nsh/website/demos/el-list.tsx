import { List, mount, signal, Text, View, type YNode } from "nsh";
import { button, buttonText, desktop, Inspector, Panel, size, tint, ui, wide } from "./palette";

type Trade = { id: string; symbol: string; shares: number; change: number };

const symbols = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "META", "GOOG", "AMD", "NFLX", "INTC"];
const LIMIT = 200;

// A page of made-up trades; ids keep counting so every row has its own key.
let next = 0;
const page = (n: number): Trade[] =>
  Array.from({ length: n }, () => {
    const i = next++;
    return { id: `t${i}`, symbol: symbols[(i * 7) % symbols.length], shares: 10 + ((i * 37) % 290), change: (((i * 53) % 200) - 100) / 10 };
  });

function App() {
  const trades = signal(page(40));
  const loading = signal(false);
  const loads = signal(0);
  const refreshing = signal(false);
  const visible = signal("");
  let list!: YNode;

  const loadMore = () => {
    if (loading() || trades().length >= LIMIT) return;
    loading.set(true);
    setTimeout(() => {
      trades.set([...trades(), ...page(20)]);
      loads.update((n) => n + 1);
      loading.set(false);
    }, 600);
  };

  const refresh = () => {
    refreshing.set(true);
    setTimeout(() => {
      next = 0;
      trades.set(page(40));
      loads.set(0);
      refreshing.set(false);
    }, 800);
  };
  const viewable = ({ viewableItems }: { viewableItems: { index: number }[] }) =>
    visible.set(viewableItems.length ? `${viewableItems[0].index}–${viewableItems[viewableItems.length - 1].index}` : "");
  const toIndex = () => list.scrollToIndex({ index: Math.min(100, trades().length - 1), viewPosition: 0.5 });
  const toEnd = () => list.scrollToEnd({ animated: true });
  const status = () => (loading() ? "Loading 20 more…" : trades().length >= LIMIT ? "The end" : "");
  const changeColor = (t: Trade) => (t.change >= 0 ? ui().up : ui().down);

  // A phone: cards in one column, pull to refresh.
  const cards = () => (
    <View style={{ flex: 1, backgroundColor: ui().page, paddingTop: 24 }}>
      <View style={{ paddingHorizontal: 16, gap: 6, paddingBottom: 8 }}>
        <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>list</Text>
        <Text style={{ color: ui().muted }}>
          {trades().length} rows · onLoadMore {loads()}× · visible {visible()}
        </Text>
      </View>
      <List
        ref={list}
        testID="trades"
        each={trades()}
        keyExtractor={(t) => t.id}
        numColumns={1}
        estimatedItemSize={64}
        style={{ flex: 1 }}
        contentStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 8 }}
        onLoadMore={loadMore}
        loadMoreThreshold={0.5}
        refreshing={refreshing()}
        onRefresh={refresh}
        viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
        onViewableItemsChange={viewable}
        header={
          <View style={{ ...ui().card, borderRadius: 14, padding: 14, gap: 10, marginBottom: 4 }}>
            <Text style={{ color: ui().muted }}>
              {desktop ? "Scroll with the wheel or trackpad" : "Swipe up; pull down to refresh"}: more rows load near the end, up to {LIMIT}.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Chip label="scrollToIndex 100" onPress={toIndex} />
              <Chip label="scrollToEnd" onPress={toEnd} />
            </View>
          </View>
        }
        footer={<Text style={{ color: ui().faint, textAlign: "center", paddingVertical: 16 }}>{status()}</Text>}
      >
        {(trade, index) => (
          <View style={{ ...ui().row, flex: 1, flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12 }}>
            <Text style={{ color: ui().faint, width: 32, fontVariant: ["tabular-nums"] }}>{index()}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: ui().text, fontWeight: "600" }}>{trade().symbol}</Text>
              <Text style={{ color: ui().muted, fontSize: 12 }}>
                {trade().shares} shares · key {trade().id}
              </Text>
            </View>
            <Text
              style={{
                color: changeColor(trade()),
                backgroundColor: tint(changeColor(trade()), 0.12),
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                overflow: "hidden",
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              {trade().change >= 0 ? "+" : ""}
              {trade().change.toFixed(1)}%
            </Text>
          </View>
        )}
      </List>
    </View>
  );

  // A wide window: a table with fixed column lanes, its controls beside it.
  const cell = { fontSize: 13, fontVariant: ["tabular-nums" as const] };
  const lanes = { index: 48, shares: 88, key: 104, change: 88 };
  const table = () => (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>list</Text>
      <Text style={{ color: ui().muted }}>
        {desktop ? "Scroll with the wheel or trackpad" : "Swipe up"}: more rows load near the end, up to {LIMIT}.
      </Text>
      <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
        <View style={{ ...ui().card, flex: 1, minWidth: 0, borderRadius: 12, overflow: "hidden" }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              height: size.rowSm,
              paddingHorizontal: 12,
              borderBottomWidth: 1,
              borderBottomColor: ui().border,
              backgroundColor: ui().inset.backgroundColor,
            }}
          >
            <Text style={{ ...cell, width: lanes.index, textAlign: "right", fontSize: 12, fontWeight: "600", color: ui().muted }}>#</Text>
            <Text style={{ ...cell, flex: 1, fontSize: 12, fontWeight: "600", color: ui().muted }}>Symbol</Text>
            <Text style={{ ...cell, width: lanes.shares, textAlign: "right", fontSize: 12, fontWeight: "600", color: ui().muted }}>Shares</Text>
            <Text style={{ ...cell, width: lanes.key, paddingStart: 16, fontSize: 12, fontWeight: "600", color: ui().muted }}>Key</Text>
            <Text style={{ ...cell, width: lanes.change, textAlign: "right", fontSize: 12, fontWeight: "600", color: ui().muted }}>Change</Text>
          </View>
          <List
            ref={list}
            testID="trades"
            each={trades()}
            keyExtractor={(t) => t.id}
            estimatedItemSize={size.row}
            style={{ flex: 1 }}
            onLoadMore={loadMore}
            loadMoreThreshold={0.5}
            refreshing={refreshing()}
            onRefresh={refresh}
            viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
            onViewableItemsChange={viewable}
            footer={<Text style={{ color: ui().faint, fontSize: 13, textAlign: "center", paddingVertical: 12 }}>{status()}</Text>}
          >
            {(trade, index) => (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  height: size.row - 4,
                  paddingHorizontal: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: ui().line,
                }}
              >
                <Text style={{ ...cell, width: lanes.index, textAlign: "right", color: ui().faint }}>{index()}</Text>
                <Text style={{ ...cell, flex: 1, fontWeight: "600", color: ui().text }}>{trade().symbol}</Text>
                <Text style={{ ...cell, width: lanes.shares, textAlign: "right", color: ui().text }}>{trade().shares}</Text>
                <Text style={{ ...cell, width: lanes.key, paddingStart: 16, color: ui().muted }}>{trade().id}</Text>
                <Text style={{ ...cell, width: lanes.change, textAlign: "right", fontWeight: "600", color: changeColor(trade()) }}>
                  {trade().change >= 0 ? "+" : ""}
                  {trade().change.toFixed(1)}%
                </Text>
              </View>
            )}
          </List>
        </View>
        <Inspector>
          <Panel title="rows · onLoadMore · visible">
            <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
              {trades().length} rows · {loads()}× · visible {visible()}
            </Text>
          </Panel>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label="scrollToIndex 100" onPress={toIndex} />
            <Chip label="scrollToEnd" onPress={toEnd} />
          </View>
        </Inspector>
      </View>
    </View>
  );

  return <>{() => (wide() ? table() : cards())}</>;
}

function Chip(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button()}>
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

mount(App);
