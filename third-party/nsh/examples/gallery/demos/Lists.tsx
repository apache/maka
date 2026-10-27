import { cleanup, computed, effect, List, Scroll, signal, Text, View, type YNode } from "nsh";
import { reduceMotion } from "nsh";
import { Animated, type AnimatedNode, createAnimatedValue, Easing, LayoutAnimation } from "nsh";
import { platform } from "nsh";
import { Tab, Tabs, Input } from "nsh/base";
import { keyboardFrame, safeAreaInsets } from "nsh";
import { Icon, type IconName } from "../icons";
import { alpha, Appear, Badge, bindRefresh, Button, colors, columnsFor, desktop, finish, hint, IconTile, Meter, mono, Press, radius, RoundButton, Section, Segmented, tabPress, type Tone, toneColor, toneTint } from "../ui";

const tones: Tone[] = ["accent", "info", "warn", "up", "danger", "neutral"];

/** A small pill action for list headers (36 pt, 44 pt with its hit slop). */
function Action(props: { label: string; icon?: IconName; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} accessibilityLabel={props.label} hitSlop={4}>
      <View
        style={{
          height: 36,
          paddingHorizontal: 14,
          borderRadius: 18,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: colors.raised,
          borderWidth: 1,
          borderColor: colors.border,
          ...finish.raised,
        }}
      >
        {props.icon ? <Icon name={props.icon} size={14} tint={colors.text} /> : null}
        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      </View>
    </Press>
  );
}

/** Three columns (as many as fit in the desktop layout, at least 130 pt
 * each), a header and a footer, padding and gaps, viewability. */
function Grid() {
  const items = Array.from({ length: 90 }, (_, i) => ({ id: i, height: 84 + (i % 4) * 22, tone: tones[i % tones.length] }));
  const first = signal(-1);
  const last = signal(-1);
  let list!: YNode;
  const wide = desktop();
  const grid = (columns: number) => (
    <List
      ref={list}
      each={items}
      numColumns={columns}
      estimatedItemSize={110}
      style={{ flex: 1 }}
      contentStyle={wide ? { padding: 24, gap: 12 } : { padding: 16, gap: 8 }}
      viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
      onViewableItemsChange={({ viewableItems }) => {
        first.set(viewableItems.length ? viewableItems[0].index : -1);
        last.set(viewableItems.length ? viewableItems[viewableItems.length - 1].index : -1);
      }}
      header={
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.card,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.border,
            padding: 16,
            gap: 12,
            marginBottom: 4,
            ...finish.card,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 13, color: colors.muted }}>Viewable items (at least half shown)</Text>
              <Text style={{ fontSize: 30, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: -0.5 }}>
                {first() < 0 ? "—" : `${first()}–${last()}`}
                <Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent }}>
                  {first() < 0 ? "" : `  ${last() - first() + 1} visible`}
                </Text>
              </Text>
            </View>
            <Text style={{ fontSize: 13, color: colors.faint, paddingBottom: 6 }}>{`90 items, ${columns} columns`}</Text>
          </View>
          <Meter value={last() < 0 ? 0 : (last() + 1) / items.length} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Action label="Jump to 60" icon="arrow-down" onPress={() => list.scrollToIndex({ index: 60, viewPosition: 0.5 })} />
            <Action label="End" onPress={() => list.scrollToEnd()} />
          </View>
        </View>
      }
      footer={
        <Text style={{ textAlign: "center", color: colors.faint, fontSize: 13, padding: 16 }}>End of the list</Text>
      }
    >
      {(item) => (
        <View
          style={{
            height: item().height,
            borderRadius: radius.inset,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: item().id === 60 ? toneColor("accent") : colors.border,
            backgroundColor: colors.raised,
            ...finish.raised,
            padding: 12,
            justifyContent: "space-between",
          }}
        >
          <View style={{ width: 18, height: 4, borderRadius: 2, backgroundColor: toneColor(item().tone) }} />
          <View>
            <Text style={{ fontSize: 22, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{item().id}</Text>
            <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{item().height} pt</Text>
          </View>
        </View>
      )}
    </List>
  );
  if (!wide) return grid(3);
  // Rebuilt when the number of columns changes.
  const columns = computed(() => columnsFor(130, 10, undefined, 12));
  return <View style={{ flex: 1 }}>{(() => grid(columns()))()}</View>;
}

const people = [
  ["Ada", "Lovelace", "Analytical Engine notes"],
  ["Alan", "Kay", "Smalltalk"],
  ["Barbara", "Liskov", "CLU, substitution"],
  ["Brian", "Kernighan", "AWK, The C book"],
  ["Claude", "Shannon", "Information theory"],
  ["Dennis", "Ritchie", "C, Unix"],
  ["Donald", "Knuth", "TeX, TAOCP"],
  ["Edsger", "Dijkstra", "Shortest paths"],
  ["Frances", "Allen", "Optimizing compilers"],
  ["Grace", "Hopper", "COBOL, the first compiler"],
  ["Guido", "van Rossum", "Python"],
  ["Ken", "Thompson", "Unix, UTF-8"],
  ["Linus", "Torvalds", "Linux, Git"],
  ["Margaret", "Hamilton", "Apollo flight software"],
  ["Niklaus", "Wirth", "Pascal, Oberon"],
] as const;

/** Section headers stick to the top until the next one pushes them out. */
function Contacts() {
  // One list of header and name rows; the headers' indices stick.
  type Row = { header: string; count: number } | { first: string; last: string; note: string; tone: Tone; end: boolean };
  const rows: Row[] = [];
  const headers: number[] = [];
  for (const letter of [...new Set(people.map((p) => p[0][0]))]) {
    const group = people.filter((p) => p[0][0] === letter);
    headers.push(rows.length);
    rows.push({ header: letter, count: group.length });
    group.forEach(([first, last, note], i) =>
      rows.push({ first, last, note, tone: tones[(rows.length + i) % (tones.length - 1)], end: i === group.length - 1 }),
    );
  }
  return (
    <List each={rows} stickyHeaderIndices={headers} estimatedItemSize={60} style={{ flex: 1 }} contentStyle={{ paddingBottom: 24 }}>
      {(row) => {
        const header = () => row() as { header: string; count: number };
        const person = () => row() as { first: string; last: string; note: string; tone: Tone; end: boolean };
        return (
          <If
            when={"header" in row()}
            else={
              <View
                onPress={() => {}}
                activeStyle={{ backgroundColor: colors.raised }}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, height: 60 }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 19,
                    backgroundColor: toneTint(person().tone),
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "600", color: toneColor(person().tone) }}>
                    {person().first[0]}
                    {person().last[0]}
                  </Text>
                </View>
                <View
                  style={{
                    flex: 1,
                    alignSelf: "stretch",
                    justifyContent: "center",
                    gap: 2,
                    paddingRight: 16,
                    borderBottomWidth: person().end ? 0 : 1,
                    borderBottomColor: colors.line,
                  }}
                >
                  <Text style={{ fontSize: 15, color: colors.text }}>
                    {person().first} <Text style={{ fontWeight: "600" }}>{person().last}</Text>
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted }}>
                    {person().note}
                  </Text>
                </View>
              </View>
            }
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                height: 34,
                paddingHorizontal: 16,
                gap: 10,
                // Opaque: rows scroll under it while it sticks.
                backgroundColor: colors.background,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "700", color: colors.accent }}>{header().header}</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
              <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{header().count}</Text>
            </View>
          </If>
        );
      }}
    </List>
  );
}

type Message = { id: number; text: string; mine: boolean; time: string };

const lines = [
  "Did the build go out?",
  "Yes, 2.4 is live on both stores",
  "Crash rate?",
  "Flat. 0.02 %",
  "Nice. The list scrolls so much smoother now",
  "Recycling plus native layout, no JS per frame",
  "Ship it",
];

/** An inverted list: starts at the newest message, keeps its place as older ones load. */
function Chat() {
  const insets = safeAreaInsets();
  let next = 0;
  const stamp = (n: number) => `${String(9 + Math.floor(n / 60) % 12).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const message = (text: string, mine: boolean): Message => ({ id: next, text, mine, time: stamp(next++) });
  const messages = signal(Array.from({ length: 30 }, (_, i) => message(lines[i % lines.length], i % 3 === 0)));
  const draft = signal("");
  const older = signal(0);
  const send = () => {
    if (!draft().trim()) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
    messages.update((m) => [message(draft(), true), ...m]);
    draft.set("");
  };
  const loadOlder = () => {
    const count = messages().length;
    older.set(older() + 1);
    messages.update((m) => [...m, ...Array.from({ length: 20 }, (_, i) => message(`Older message ${count + i + 1}`, i % 4 === 0))]);
  };
  return (
    <View style={{ flex: 1, paddingBottom: "env(keyboard-inset-height)" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.up }} />
        <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>Release room</Text>
        <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>
          {messages().length} messages, {older()} older pages
        </Text>
      </View>
      <List
        each={messages()}
        inverted
        estimatedItemSize={52}
        style={{ flex: 1 }}
        contentStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}
        keyboardDismissMode="interactive"
        onLoadMore={loadOlder}
        loadMoreThreshold={0.5}
      >
        {(m) => (
          <View style={{ alignSelf: m().mine ? "flex-end" : "flex-start", maxWidth: "78%", gap: 3, alignItems: m().mine ? "flex-end" : "flex-start" }}>
            <View
              style={{
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 18,
                borderCurve: "continuous",
                borderBottomRightRadius: m().mine ? 6 : 18,
                borderBottomLeftRadius: m().mine ? 18 : 6,
                backgroundColor: m().mine ? colors.accentFill : colors.raised,
                ...(m().mine ? finish.accent : finish.raised),
                borderWidth: m().mine ? 0 : 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: m().mine ? colors.onAccent : colors.text, fontSize: 15 }}>{m().text}</Text>
            </View>
            <Text style={{ fontSize: 11, color: colors.faint, fontVariant: ["tabular-nums"], paddingHorizontal: 4 }}>{m().time}</Text>
          </View>
        )}
      </List>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom),
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <Input
          value={draft()}
          onChange={(v) => draft.set(v)}
          onSubmit={send}
          submitBehavior="submit"
          placeholder="Message"
          returnKeyType="send"
          style={{
            placeholderColor: colors.faint,
            selectionColor: colors.accent,
            flex: 1,
            height: 44,
            fontSize: 15,
            color: colors.text,
            backgroundColor: colors.field,
            ...finish.field,
            borderWidth: 1,
            borderColor: colors.fieldBorder,
            borderRadius: 22,
            paddingHorizontal: 16,
          }}
        />
        <RoundButton icon="arrow-up" label="Send" onPress={send} />
      </View>
    </View>
  );
}

const ranges = ["Today", "Yesterday", "This week", "This month", "This year", "All time", "Custom"];

const indicators = [
  { value: "system", label: "System spinner" },
  { value: "custom", label: "Custom indicator" },
] as const;

/** How tall the custom indicator is: where a pull refreshes, and the room it keeps while refreshing. */
const INDICATOR = 72;

/**
 * A pull-to-refresh indicator drawn by the app, in the gallery's look, over the top of a scroll view: a round chip
 * that travels in with the pull (`pull`, its `pullValue`), grows and fades in, turns its arrow over once the pull
 * reaches the height where it refreshes, and spins while it refreshes. The pull drives all of it on the UI thread.
 */
function CustomIndicator(props: { pull: AnimatedNode; refreshing: boolean }) {
  const turn = createAnimatedValue(0);
  const spin = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear }));
  effect(() => {
    if (props.refreshing && !reduceMotion()) {
      turn.set(0);
      spin.start();
    } else {
      spin.stop();
    }
  });
  cleanup(() => spin.stop());
  const pull = props.pull;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, height: INDICATOR, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.raised,
          ...finish.raised,
          alignItems: "center",
          justifyContent: "center",
          opacity: pull.interpolate({ inputRange: [0, 24], outputRange: [0, 1] }),
          transform: [
            { translateY: pull.interpolate({ inputRange: [0, INDICATOR], outputRange: [-28, 0] }) },
            { scale: pull.interpolate({ inputRange: [0, INDICATOR], outputRange: [0.6, 1] }) },
          ],
        }}
      >
        {/* The arrow points down while pulling and turns up once releasing refreshes. */}
        <View
          style={{
            position: "absolute",
            opacity: props.refreshing ? 0 : 1,
            transform: [{ rotate: pull.interpolate({ inputRange: [INDICATOR * 0.5, INDICATOR], outputRange: ["0deg", "180deg"] }) }],
          }}
        >
          <Icon name="arrow-down" size={18} tint={colors.accent} />
        </View>
        <View
          style={{
            position: "absolute",
            width: 20,
            height: 20,
            borderRadius: 10,
            borderWidth: 2,
            borderColor: alpha(colors.accent, 0.25),
            borderTopColor: colors.accent,
            opacity: props.refreshing ? 1 : 0,
            transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
          }}
        />
      </View>
    </View>
  );
}

/** Horizontal scrolling, pull to refresh on a plain scroll view (the system spinner or a custom indicator), and an empty list. */
function More() {
  const refreshing = signal(false);
  const refreshed = signal(0);
  const indicator = signal<"system" | "custom">("system");
  const pull = createAnimatedValue(0);
  const range = signal("This week");
  const items = signal<{ n: number; tone: Tone }[]>([]);
  const refresh = () => {
    refreshing.set(true);
    setTimeout(() => {
      refreshed.set(refreshed() + 1);
      refreshing.set(false);
    }, 1000);
  };
  const refreshKey = bindRefresh(refresh);
  const edit = (change: () => void) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    change();
  };
  const cards = Array.from({ length: 1000 }, (_, i) => i);
  const custom = () => indicator() === "custom";
  const page = (
    <Scroll
      style={{ flex: 1 }}
      refreshing={refreshing()}
      onRefresh={refresh}
      pullValue={pull}
      refreshIndicator={custom() ? { height: INDICATOR } : undefined}
    >
      <View style={{ padding: 16, gap: 16 }}>
        {/* `position: sticky`: in the flow, then at the top while the page scrolls under it. */}
        <View
          style={{
            position: "sticky",
            top: 0,
            flexDirection: "row",
            alignItems: "baseline",
            gap: 8,
            marginHorizontal: -16,
            marginTop: -8,
            paddingHorizontal: 16,
            paddingVertical: 8,
            backgroundColor: colors.background,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>More list features</Text>
          <Text style={{ fontSize: 13, color: colors.faint, fontFamily: mono }}>position: sticky</Text>
        </View>
        <Section title="Pull to refresh">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <IconTile name="arrow-down" tint={refreshing() ? colors.accent : colors.text} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, color: colors.text }}>{refreshing() ? "Refreshing…" : hint("Pull the page down", refreshKey ? `Refresh or ${refreshKey}` : "Refresh below")}</Text>
              <Text style={{ fontSize: 13, color: colors.muted }}>{custom() ? "An indicator the app draws, from pullValue" : "The system spinner on a plain scroll view"}</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{refreshed()}</Text>
              <Text style={{ fontSize: 12, color: colors.faint }}>refreshes</Text>
            </View>
          </View>
          <Segmented options={indicators} value={indicator()} onChange={(v) => indicator.set(v)} />
          {/* The mouse does not pull scroll views down: desktops refresh here. */}
          <If when={platform.idiom === "desktop"}>
            <Button label="Refresh" variant="secondary" disabled={refreshing()} onPress={refresh} />
          </If>
        </Section>

        <Section title="Horizontal scroll view" note={range()}>
          <View style={{ marginHorizontal: -14 }}>
            <Scroll horizontal scrollbar={false}>
              <Tabs style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14 }}>
                <Each of={ranges}>
                  {(label) => (
                    <Tab selected={range() === label()} onPress={() => range.set(label())} style={tabPress.style} activeStyle={tabPress.activeStyle}>
                      <View
                        style={{
                          height: 36,
                          paddingHorizontal: 14,
                          borderRadius: 18,
                          justifyContent: "center",
                          backgroundColor: range() === label() ? colors.light : colors.raised,
                          ...(range() === label() ? finish.light : finish.raised),
                          borderWidth: range() === label() ? 0 : 1,
                          borderColor: colors.border,
                        }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: "600", color: range() === label() ? colors.onLight : colors.muted }}>{label()}</Text>
                      </View>
                    </Tab>
                  )}
                </Each>
              </Tabs>
            </Scroll>
          </View>
        </Section>

        <Section title="Horizontal list" note="1,000 recycled cards">
          <View style={{ marginHorizontal: -14 }}>
            <List each={cards} horizontal estimatedItemSize={130} scrollbar={false} style={{ height: 124 }} contentStyle={{ paddingHorizontal: 14, gap: 10 }}>
              {(i) => {
                const tone = () => tones[i() % (tones.length - 1)];
                const load = () => ((i() * 37) % 100) / 100;
                return (
                  <View
                    style={{
                      width: 120,
                      height: 124,
                      borderRadius: radius.inset,
                      borderCurve: "continuous",
                      backgroundColor: colors.raised,
                      ...finish.raised,
                      borderWidth: 1,
                      borderColor: colors.border,
                      padding: 12,
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ fontSize: 12, color: colors.muted, fontVariant: ["tabular-nums"] }}>Card {i() + 1}</Text>
                    <Text style={{ fontSize: 26, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>
                      {Math.round(load() * 100)}
                      <Text style={{ fontSize: 15, fontWeight: "500", color: toneColor(tone()) }}> %</Text>
                    </Text>
                    <Meter value={load()} tone={tone()} />
                  </View>
                );
              }}
            </List>
          </View>
        </Section>

        <Section title="An empty list" note={`${items().length} items`}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button
                label="Add"
                icon="plus"
                onPress={() => edit(() => items.set([...items(), { n: items().length + 1, tone: tones[items().length % (tones.length - 1)] }]))}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Clear" variant="secondary" disabled={!items().length} onPress={() => edit(() => items.set([]))} />
            </View>
          </View>
          <List
            viewport="parent"
            each={items()}
            estimatedItemSize={48}
            style={{ borderRadius: radius.control, backgroundColor: colors.surface, ...finish.card, borderWidth: 1, borderColor: colors.line }}
            empty={
              <View style={{ alignItems: "center", justifyContent: "center", gap: 10, height: 194 }}>
                <IconTile name="lists" tint={colors.faint} />
                <Text style={{ fontSize: 13, color: colors.muted }}>{hint("Nothing here yet: tap Add", "Nothing here yet: click Add")}</Text>
              </View>
            }
            separator={() => <View style={{ height: 1, marginLeft: 14, backgroundColor: colors.line }} />}
          >
            {(item) => (
              <View style={{ height: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 }}>
                <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: toneColor(item().tone) }} />
                <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>Item {item().n}</Text>
                <Badge label={item().tone} tone={item().tone} />
              </View>
            )}
          </List>
          <Text style={{ fontSize: 13, color: colors.muted }}>
            <Text style={{ fontFamily: mono, color: colors.text }}>ListEmptyComponent</Text> while empty, separators between rows; changes animate with{" "}
            <Text style={{ fontFamily: mono, color: colors.text }}>LayoutAnimation</Text>. In the page (
            <Text style={{ fontFamily: mono, color: colors.text }}>viewport="parent"</Text>), the list is as tall as its rows.
          </Text>
        </Section>
      </View>
    </Scroll>
  );
  return (
    <View style={{ flex: 1 }}>
      {page}
      <If when={custom()}>
        <CustomIndicator pull={pull} refreshing={refreshing()} />
      </If>
    </View>
  );
}

type Entry = { id: number; tone: Tone };

const entries = (from: number, count: number): Entry[] =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, tone: tones[(from + i) % (tones.length - 1)] }));

/** One row of the page's lists. */
function EntryRow(props: { entry: Entry; label: string }) {
  return (
    <View
      style={{
        height: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 14,
        borderRadius: radius.inset,
        borderCurve: "continuous",
        backgroundColor: colors.raised,
        borderWidth: 1,
        borderColor: colors.border,
        ...finish.raised,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 2.5, backgroundColor: toneColor(props.entry.tone) }} />
      <Text style={{ flex: 1, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] }}>
        {props.label} {props.entry.id + 1}
      </Text>
      <Badge label={props.entry.tone} tone={props.entry.tone} />
    </View>
  );
}

/** A week's heading in the page's first list: it sticks to the top of the
 * page while its rows scroll under it. */
function WeekHeading(props: { week: number }) {
  return (
    <View
      style={{
        height: 34,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 4,
        // Opaque: rows scroll under it while it sticks.
        backgroundColor: colors.background,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: "700", color: colors.accent }}>Week {props.week}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}

type PageRow = Entry | { week: number };

/** The height of the page's bar, which hides as the page scrolls down. */
const BAR = 44;

/** Headers and two lists on one page: the lists have no scroll view of
 * their own (`viewport="parent"`), the page scrolls them as one, and only
 * their rows near its viewport exist. A bar over the page hides as it
 * scrolls down and comes back as it scrolls up (`diffClamp`), and the
 * first list's week headings stick just below it, wherever it is
 * (`stickyHeaderOffset` set to how much of it shows). */
function Page() {
  const scroll = createAnimatedValue(0);
  // How much of the bar is hidden, following the page's scrolling.
  const hidden = scroll.diffClamp(0, BAR);
  // How much of it shows: where the week headings stick.
  const shown = hidden.mul(-1).add(BAR);
  // 200 entries, a week heading before every 20.
  const recent: PageRow[] = entries(0, 200).flatMap((e) => (e.id % 20 === 0 ? [{ week: e.id / 20 + 1 }, e] : [e]));
  const weeks = recent.flatMap((row, i) => ("week" in row ? [i] : []));
  const indexOf = (id: number) => recent.findIndex((row) => "id" in row && row.id === id);
  const archive = signal(entries(0, 100));
  let list!: YNode;
  const loadMore = () => {
    if (archive().length < 500) archive.update((a) => [...a, ...entries(a.length, 100)]);
  };
  const heading = (title: string, note: string) => (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 4, paddingTop: 8 }}>
      <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{title}</Text>
      <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{note}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1, overflow: "hidden" }}>
      <Scroll testID="page" scrollValue={scroll} style={{ flex: 1 }}>
        <View style={{ padding: 16, paddingTop: 16 + BAR, gap: 10, width: "100%", maxWidth: 720, alignSelf: "center" }}>
          <Section title="One page, two lists" note={'viewport="parent"'}>
            <Text style={{ fontSize: 13, color: colors.muted }}>
              The lists below lie in the page at their full length, and the page scrolls them with this header: only the
              rows near its viewport exist, in recycled cells.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Action label="Recent 150" icon="arrow-down" onPress={() => list.scrollToIndex({ index: indexOf(149), viewPosition: 0.5 })} />
              <Action label="End of recent" onPress={() => list.scrollToEnd()} />
            </View>
          </Section>
          {heading("Recent", "200 rows")}
          <List
            ref={list}
            viewport="parent"
            each={recent}
            estimatedItemSize={56}
            stickyHeaderIndices={weeks}
            stickyHeaderOffset={shown}
            contentStyle={{ gap: 6 }}
          >
            {(row) => (
              <If when={"week" in row()} else={<EntryRow entry={row() as Entry} label="Recent" />}>
                <WeekHeading week={(row() as { week: number }).week} />
              </If>
            )}
          </List>
          {heading("Archive", `${archive().length} rows`)}
          <List
            viewport="parent"
            each={archive()}
            estimatedItemSize={56}
            contentStyle={{ gap: 6 }}
            onLoadMore={loadMore}
            footer={
              <Text style={{ textAlign: "center", color: colors.faint, fontSize: 13, padding: 16 }}>
                {archive().length < 500 ? "Loading more…" : "End of the archive"}
              </Text>
            }
          >
            {(entry) => <EntryRow entry={entry()} label="Archived" />}
          </List>
        </View>
      </Scroll>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: BAR,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 20,
          backgroundColor: colors.background,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          transform: [{ translateY: hidden.mul(-1) }],
        }}
      >
        <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>Recent and archived</Text>
        <Text style={{ fontSize: 13, color: colors.faint }}>hides as you scroll down</Text>
      </View>
    </View>
  );
}

type ListTab = "grid" | "sections" | "chat" | "page" | "more";

const tabs = [
  { value: "grid", label: "Grid" },
  { value: "sections", label: "Sections" },
  { value: "chat", label: "Chat" },
  { value: "page", label: "Page" },
  { value: "more", label: "More" },
] as const;

export function Lists() {
  const tab = signal<ListTab>("grid");
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={desktop() ? { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 4, width: "100%", maxWidth: 600 } : { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <Segmented options={tabs} value={tab()} onChange={(v) => tab.set(v)} />
      </View>
      {(() => {
        switch (tab()) {
          case "grid":
            return (
              <Appear flex>
                <Grid />
              </Appear>
            );
          case "sections":
            return (
              <Appear flex>
                <Contacts />
              </Appear>
            );
          case "chat":
            return (
              <Appear flex>
                <Chat />
              </Appear>
            );
          case "page":
            return (
              <Appear flex>
                <Page />
              </Appear>
            );
          case "more":
            return (
              <Appear flex>
                <More />
              </Appear>
            );
        }
      })()}
    </View>
  );
}
