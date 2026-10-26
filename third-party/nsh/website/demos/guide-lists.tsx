import { effect, List, mount, signal, Text, View, type YNode } from "nsh";
import { windowSize } from "nsh";
import { focusRing, hoverFill, size, tint, ui, wide } from "./palette";

/** In a wide window the lists sit in one centered region, 760 points across. */
const REGION = 760;

// Grid tiles, tinted with the status and info colours.
const tints = ["down", "up", "info", "warn", "faint", "violet"] as const;

type Post = { id: number; title: string };

/** Bumped when the selected tab is tapped again: its list scrolls to the top. */
const toTop = signal(0);

/** An endless feed: loads more near the end, pull to refresh, scroll to an item. */
function Feed() {
  let next = 0;
  const make = (n: number): Post[] => Array.from({ length: n }, () => ({ id: next, title: `Post ${++next}` }));
  const posts = signal(make(40));
  const refreshing = signal(false);
  const visible = signal("");
  let list!: YNode;
  effect(() => {
    if (toTop() > 0) list.scrollToOffset({ offset: 0 });
  });
  return (
    <List
      ref={list}
      each={posts()}
      keyExtractor={(p) => String(p.id)}
      estimatedItemSize={wide() ? size.row : 56}
      style={wide() ? { ...ui().card, flex: 1, margin: 20, marginTop: 12, borderRadius: 12, overflow: "hidden" } : { flex: 1 }}
      contentStyle={wide() ? {} : { padding: 12, gap: 8 }}
      onLoadMore={() => posts.update((p) => [...p, ...make(20)])}
      loadMoreThreshold={0.5}
      refreshing={refreshing()}
      onRefresh={() => {
        refreshing.set(true);
        setTimeout(() => {
          next = 0;
          posts.set(make(40));
          refreshing.set(false);
        }, 800);
      }}
      viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
      onViewableItemsChange={({ viewableItems }) =>
        visible.set(viewableItems.length ? `${viewableItems[0].index}–${viewableItems[viewableItems.length - 1].index}` : "")
      }
      header={
        <View
          style={
            wide()
              ? { flexDirection: "row", alignItems: "center", gap: 12, height: size.rowSm, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: ui().line, backgroundColor: ui().inset.backgroundColor }
              : { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 4 }
          }
        >
          <Text style={{ flex: 1, color: ui().muted, fontSize: wide() ? 13 : undefined }}>
            {posts().length} posts, visible {visible()}
          </Text>
          <Text onPress={() => list.scrollToIndex({ index: 30, viewPosition: 0.5 })} style={{ color: ui().accent, fontSize: wide() ? 13 : undefined }} hoverStyle={hoverFill()} focusStyle={focusRing()} activeStyle={{ opacity: 0.7 }}>
            #30
          </Text>
          <Text onPress={() => list.scrollToOffset({ offset: 0 })} style={{ color: ui().accent, fontSize: wide() ? 13 : undefined }} hoverStyle={hoverFill()} focusStyle={focusRing()} activeStyle={{ opacity: 0.7 }}>
            Top
          </Text>
        </View>
      }
    >
      {(post) => (
        <View
          style={
            wide()
              ? { height: size.row, paddingHorizontal: 12, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: ui().line }
              : { ...ui().row, padding: 16, borderRadius: 12 }
          }
        >
          <Text style={{ fontSize: wide() ? size.label : 16, color: ui().text }}>{post().title}</Text>
        </View>
      )}
    </List>
  );
}

/** Three columns of different heights. */
function Grid() {
  const items = Array.from({ length: 300 }, (_, i) => ({ id: i, height: 60 + (i % 4) * 18 }));
  return (
    <List
      each={items}
      numColumns={wide() ? 6 : 3}
      estimatedItemSize={80}
      style={{ flex: 1 }}
      contentStyle={wide() ? { padding: 20, paddingTop: 12, gap: 8 } : { padding: 12, gap: 8 }}
    >
      {(item) => (
        <View style={{ height: item().height, borderRadius: 10, backgroundColor: tint(ui()[tints[item().id % tints.length]], 0.16), alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontWeight: "600", color: ui().text }}>{item().id}</Text>
        </View>
      )}
    </List>
  );
}

/** Sticky letter headers: one list of header and name rows. */
function Contacts() {
  const names = ["Ada", "Alan", "Anita", "Barbara", "Bjarne", "Brian", "Claude", "Dennis", "Donald", "Edsger", "Frances", "Grace", "Guido", "Hedy", "Ken", "Linus", "Margaret", "Niklaus", "Radia", "Tim"];
  type Row = { header: string } | { name: string };
  const rows: Row[] = [];
  const headers: number[] = [];
  for (const letter of [...new Set(names.map((n) => n[0]))]) {
    headers.push(rows.length);
    rows.push({ header: letter });
    for (const name of names.filter((n) => n[0] === letter)) rows.push({ name });
  }
  return (
    <List
      each={rows}
      stickyHeaderIndices={headers}
      estimatedItemSize={wide() ? size.rowSm : 44}
      style={
        wide()
          ? { ...ui().card, flex: 1, margin: 20, marginTop: 12, borderRadius: 12, overflow: "hidden" }
          : { flex: 1, backgroundColor: ui().card.backgroundColor }
      }
    >
      {(row) => (
        <If
          when={"header" in row()}
          else={
            <View
              style={
                wide()
                  ? { height: size.rowSm, paddingHorizontal: 12, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: ui().line }
                  : { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: ui().line }
              }
            >
              <Text style={{ fontSize: wide() ? size.label : 16, color: ui().text }}>{(row() as { name: string }).name}</Text>
            </View>
          }
        >
          <View style={{ backgroundColor: ui().inset.backgroundColor, paddingHorizontal: wide() ? 12 : 16, paddingVertical: wide() ? 4 : 6 }}>
            <Text style={{ fontWeight: "700", fontSize: wide() ? 12 : undefined, color: ui().muted }}>{(row() as { header: string }).header}</Text>
          </View>
        </If>
      )}
    </List>
  );
}

type Tab = "feed" | "grid" | "contacts";

function App() {
  const tab = signal<Tab>("feed");
  const button = (id: Tab, label: string) => (
    <Text
      onPress={() => (tab() === id ? toTop.update((n) => n + 1) : tab.set(id))}
      style={{
        flex: 1,
        textAlign: "center",
        paddingVertical: wide() ? 4 : 6,
        fontSize: wide() ? 13 : undefined,
        borderRadius: 8,
        overflow: "hidden",
        fontWeight: "600",
        color: tab() === id ? ui().text : ui().muted,
        backgroundColor: tab() === id ? ui().raised.backgroundColor : "transparent",
        backgroundImage: tab() === id ? ui().raised.backgroundImage : "none",
        boxShadow: tab() === id ? ui().raised.boxShadow : "none",
      }}
      hoverStyle={{ opacity: 0.88 }}
      focusStyle={focusRing()}
      activeStyle={{ opacity: 0.7 }}
    >
      {label}
    </Text>
  );
  return (
    <View
      style={
        wide()
          ? { flex: 1, backgroundColor: ui().page, paddingTop: 24, paddingHorizontal: Math.max(0, (windowSize().width - REGION) / 2) }
          : { flex: 1, backgroundColor: ui().page, paddingTop: 24 }
      }
    >
      <View
        style={
          wide()
            ? { ...ui().inset, flexDirection: "row", alignSelf: "flex-start", width: 320, marginHorizontal: 20, padding: 3, borderRadius: 10 }
            : { ...ui().inset, flexDirection: "row", marginHorizontal: 12, padding: 3, borderRadius: 10 }
        }
      >
        {button("feed", "Feed")}
        {button("grid", "Grid")}
        {button("contacts", "Sticky")}
      </View>
      {() => {
        switch (tab()) {
          case "feed":
            return <Feed />;
          case "grid":
            return <Grid />;
          case "contacts":
            return <Contacts />;
        }
      }}
    </View>
  );
}

mount(App);
