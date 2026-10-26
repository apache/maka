import { mount, Scroll, signal, Text, View, type YNode } from "nsh";
import { createAnimatedValue } from "nsh";
import { button, buttonText, desktop, size, tint, ui, wide } from "./palette";

// Tints of the info, violet, danger, warn and up colours under the text colour.
const hues = ["info", "violet", "down", "warn", "up", "faint"] as const;
const hue = (i: number) => tint(ui()[hues[i % hues.length]], 0.28);

/** Pages as wide as the scroll view, with a page indicator. */
function Pager() {
  const width = signal(340);
  const page = signal(0);
  return (
    <View style={{ gap: 8 }}>
      <Scroll
        horizontal
        pagingEnabled
        scrollbar={false}
        style={{ height: 110, borderRadius: 12 }}
        onLayout={(e) => width.set(e.size.width)}
        onMomentumEnd={(e) => page.set(Math.round(e.x / width()))}
        onScrollEnd={(e) => page.set(Math.round(e.x / width()))}
      >
        <View style={{ flexDirection: "row" }}>
          <Each of={[0, 1, 2, 3]}>
            {(i) => (
              <View style={{ width: width(), height: 110, backgroundColor: hue(i()), alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: ui().text, fontSize: 24, fontWeight: "700" }}>Page {i() + 1}</Text>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
        <Each of={[0, 1, 2, 3]}>
          {(i) => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: page() === i() ? ui().accent : ui().border }} />}
        </Each>
      </View>
    </View>
  );
}

/** Cards that snap: one stop every card plus gap. */
function Cards() {
  return (
    <Scroll horizontal scrollbar={false} snapToInterval={152} decelerationRate="fast" style={{ height: 90 }}>
      <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 4 }}>
        <Each of={Array.from({ length: 12 }, (_, i) => i)}>
          {(i) => (
            <View
              style={{
                width: 140,
                height: 90,
                borderRadius: 14,
                backgroundColor: hue(i()),
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: ui().text, fontWeight: "700" }}>Card {i() + 1}</Text>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}

function App() {
  // The vertical offset, written natively in the frame it changes.
  const offset = createAnimatedValue(0);
  const y = signal(0);
  const refreshing = signal(false);
  const refreshed = signal(0);
  let scroll!: YNode;
  const refresh = () => {
    refreshing.set(true);
    setTimeout(() => {
      refreshed.update((n) => n + 1);
      refreshing.set(false);
    }, 1200);
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, paddingTop: 24 }}>
      {/* A bar that fades in and shrinks its title as the page scrolls: no JS per frame. */}
      <View
        style={{
          height: 48,
          paddingHorizontal: 16,
          justifyContent: "center",
          backgroundColor: offset.interpolate({ inputRange: [0, 80], outputRange: [ui().page, ui().card.backgroundColor] }),
          borderBottomWidth: 1,
          borderBottomColor: ui().line,
        }}
      >
        <Text
          style={{
            fontSize: 22,
            fontWeight: "700",
            color: ui().text,
            transformOrigin: "left center",
            transform: [{ scale: offset.interpolate({ inputRange: [0, 80], outputRange: [1, 0.8] }) }],
          }}
        >
          Scrolling
        </Text>
      </View>
      <Scroll
        ref={scroll}
        style={{ flex: 1 }}
        scrollValue={offset}
        scrollEventThrottle={100}
        onScroll={(e) => y.set(Math.round(e.offset.y))}
        refreshing={refreshing()}
        onRefresh={refresh}
        keyboardDismissMode="on-drag"
      >
        <View style={{ padding: 16, gap: 18, maxWidth: wide() ? 720 : undefined }}>
          <Text style={{ color: ui().muted }}>
            {desktop ? `Scroll with the wheel or the trackpad. onScroll: y = ${y()}` : `Pull down to refresh (${refreshed()}×). onScroll: y = ${y()}`}
          </Text>
          <Text style={{ fontWeight: "600", color: ui().text }}>pagingEnabled</Text>
          <Pager />
          <Text style={{ fontWeight: "600", color: ui().text }}>snapToInterval</Text>
          <Cards />
          <View style={{ gap: desktop ? 8 : 18 }}>
            <Each of={Array.from({ length: 24 }, (_, i) => i + 1)}>
              {(n) => (
                <View
                  style={
                    desktop
                      ? { ...ui().row, height: size.row, justifyContent: "center", paddingHorizontal: 12, borderRadius: 8 }
                      : { ...ui().row, padding: 14, borderRadius: 12 }
                  }
                >
                  <Text style={{ color: ui().text, fontSize: desktop ? size.label : undefined }}>Row {n()}</Text>
                </View>
              )}
            </Each>
          </View>
          <View
            onPress={() => scroll.scrollTo({ y: 0 })}
            {...button("primary")}
          >
            <Text style={buttonText("primary")}>Back to the top (ref.scrollTo)</Text>
          </View>
        </View>
      </Scroll>
    </View>
  );
}

mount(App);
