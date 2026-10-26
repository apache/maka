import { mount, Scroll, signal, Text, View, type YNode } from "nsh";
import { button, buttonText, desktop, Inspector, Panel, size, ui, wide } from "./palette";

// The page colors, read when they render: they follow the theme.
const colors = (): string[] => [ui().accent, ui().info, ui().violet, ui().down, ui().warn, ui().up];

function App() {
  const page = signal(0);
  // A page is as wide as the scroll view: 390 on a phone, wider on a desktop.
  const width = signal(390);
  const y = signal(0);
  let scroller!: YNode;
  const rows = Array.from({ length: 40 }, (_, i) => i + 1);

  /** Pages as wide as the scroll view; `inset`: each page's margin. */
  const pager = (inset: number, style: object) => (
    <Scroll
      horizontal
      pagingEnabled
      scrollbar={false}
      style={style}
      onLayout={(e) => width.set(e.size.width)}
      onMomentumEnd={(e) => page.set(Math.round(e.x / width()))}
    >
      <Each of={colors()}>
        {(color, index) => (
          <View style={{ width: width(), padding: inset }}>
            <View style={{ flex: 1, borderRadius: 16, backgroundColor: color(), alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: ui().page, fontSize: 32, fontWeight: "700" }}>{index() + 1}</Text>
            </View>
          </View>
        )}
      </Each>
    </Scroll>
  );
  const toTop = (compact: boolean) => (
    <View
      onPress={() => scroller.scrollTo({ y: 0, animated: true })}
      {...button("secondary", { size: compact ? "md" : "sm" })}
    >
      <Text style={buttonText()}>scrollTo top</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, paddingTop: 24, gap: 12 }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>scroll</Text>
            <Text style={{ color: ui().muted }}>
              {desktop ? "Shift+wheel or swipe the trackpad across the pages; the wheel scrolls the rows" : "Swipe the pages and the rows"}
            </Text>
            <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 12 }}>
                {pager(0, { height: 150, flexGrow: 0, borderRadius: 16 })}
                {/* The scroll view fills its region, so its scrollbar sits at the region's edge. */}
                <View style={{ flex: 1, borderRadius: 16, borderWidth: 1, borderColor: ui().line, overflow: "hidden" }}>
                  <Scroll ref={scroller} style={{ flex: 1 }} scrollEventThrottle={16} onScroll={(e) => y.set(e.offset.y)}>
                    <View style={{ padding: 12, gap: 6 }}>
                      <Each of={rows}>
                        {(n) => (
                          <View style={{ ...ui().row, borderRadius: 8, height: size.row, paddingHorizontal: 12, justifyContent: "center" }}>
                            <Text style={{ color: ui().text, fontSize: size.label }}>Row {n()}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </Scroll>
                </View>
              </View>
              <Inspector>
                <Panel title="Horizontal, pagingEnabled · onMomentumEnd">
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                    page {page() + 1} of {colors().length}
                  </Text>
                </Panel>
                <Panel title="Vertical · onScroll">
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>y = {Math.round(y())}</Text>
                </Panel>
                {toTop(true)}
              </Inspector>
            </View>
          </View>
        ) : (
          <>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text, paddingHorizontal: 20 }}>scroll</Text>

            <Text style={{ color: ui().muted, paddingHorizontal: 20 }}>
              Horizontal, pagingEnabled · page {page() + 1} · {desktop ? "Shift+wheel or swipe the trackpad" : "swipe"}
            </Text>
            {pager(12, { height: 140, flexGrow: 0 })}

            <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20 }}>
              <Text style={{ color: ui().muted }}>Vertical · y = {Math.round(y())}</Text>
              {toTop(false)}
            </View>
            <Scroll ref={scroller} style={{ flex: 1 }} scrollEventThrottle={16} onScroll={(e) => y.set(e.offset.y)}>
              <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", paddingHorizontal: 20, paddingBottom: 20, gap: 8 }}>
                <Each of={rows}>
                  {(n) => (
                    <View style={{ ...ui().row, borderRadius: 12, padding: 14 }}>
                      <Text style={{ color: ui().text }}>Row {n()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </>
        )
      }
    </View>
  );
}

mount(App);
