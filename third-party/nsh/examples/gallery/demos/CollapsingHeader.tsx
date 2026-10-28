import { List, platform, Scroll, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { alpha, colors, density, finish } from "../ui";

const pointer = platform.idiom === "desktop";
/** How tall the header is open, and the bar it collapses to: compact with
 * a pointer, roomier on a touch screen. */
const OPEN = pointer ? 168 : 220;
const BAR = pointer ? 44 : 56;
/** The rows' height, the headings' and the gutter. */
const ROW = pointer ? 36 : 52;
const HEADING = pointer ? 28 : 34;
const GUTTER = pointer ? 24 : 16;
/** How far the page scrolls while the header collapses. */
const RANGE = OPEN - BAR;

type Row = { week: number } | { title: string; detail: string };

const rows: Row[] = [];
for (let week = 1; week <= 20; week++) {
  rows.push({ week });
  for (let i = 1; i <= 8; i++) rows.push({ title: `Entry ${week}.${i}`, detail: `${(week * 7 + i * 3) % 60} min` });
}
const weeks = rows.flatMap((row, i) => ("week" in row ? [i] : []));

/** A header that collapses to a bar as the page scrolls, as Flutter's
 * `SliverAppBar` does: it is sticky with a negative `top`, so it scrolls
 * until its last `BAR` points show and then stays; its picture moves at
 * half speed, its title shrinks into the bar and its color fills in, all
 * on the UI thread from the page's `scrollValue`. Pulled past the top, the
 * picture stretches. The title sits in the header's last `BAR` points, the
 * bar it collapses to, so it is centered there at every step. The page's
 * list (`viewport="parent"`) sticks its week headings just below the bar;
 * only the rows near the screen exist, and the footer after it lies past
 * its full length. */
export function CollapsingHeader() {
  const scroll = createAnimatedValue(0);
  // 0 open, 1 collapsed.
  const collapsed = scroll.interpolate({ inputRange: [0, RANGE], outputRange: [0, 1] });
  return (
    <Scroll testID="page" scrollValue={scroll} style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        testID="header"
        style={{ position: "sticky", top: -RANGE, height: OPEN, overflow: "hidden", backgroundColor: colors.light, ...finish.light, borderBottomWidth: 1 }}
      >
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: OPEN,
            transformOrigin: "center bottom",
            translate: [0, scroll.interpolate({ inputRange: [0, RANGE], outputRange: [0, RANGE / 2] })],
            scale: scroll.interpolate({ inputRange: [-OPEN, 0], outputRange: [2, 1] }),
          }}
        >
          {/* Rings from the trailing corner: a quiet picture that moves at half speed. */}
          {[1, 2, 3, 4].map((n) => (
            <View
              style={{
                position: "absolute",
                right: -n * 52,
                top: -n * 52 + 24,
                width: n * 104,
                height: n * 104,
                borderRadius: n * 52,
                borderWidth: 1,
                borderColor: alpha(colors.onLight, 0.1 - n * 0.015),
              }}
            />
          ))}
        </View>
        {/* Collapsed, the bar is a flat fill under the title. */}
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.light, opacity: collapsed }} />
        {/* Shown while open, above the bar's strip: it fades as the header collapses. */}
        <Text
          style={{
            position: "absolute",
            left: GUTTER,
            bottom: BAR - 2,
            color: alpha(colors.onLight, 0.62),
            fontSize: density.note,
            fontWeight: "500",
            opacity: collapsed.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0] }),
          }}
        >
          160 entries, by week
        </Text>
        {/* The title, centered in the header's last BAR points: the bar it
            collapses to. It shrinks to the bar's size around its left edge. */}
        <View style={{ position: "absolute", left: GUTTER, right: GUTTER, bottom: 0, height: BAR, justifyContent: "center" }}>
          <Text
            style={{
              alignSelf: "flex-start",
              color: colors.onLight,
              fontSize: pointer ? 26 : 30,
              fontWeight: "700",
              letterSpacing: -0.4,
              transformOrigin: "left center",
              scale: collapsed.interpolate({ inputRange: [0, 1], outputRange: [1, pointer ? 0.58 : 0.62] }),
            }}
          >
            Recent
          </Text>
        </View>
      </View>
      <List viewport="parent" each={rows} estimatedItemSize={ROW} stickyHeaderIndices={weeks} stickyHeaderOffset={BAR}>
        {(row) => (
          // A cell shows a heading now and an entry later: `If` switches
          // with the row it shows.
          <If
            when={"week" in row()}
            else={
              <View
                style={{
                  height: ROW,
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: GUTTER,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.line,
                }}
              >
                <Text style={{ flex: 1, fontSize: density.body, color: colors.text }}>{(row() as { title: string }).title}</Text>
                <Text style={{ fontSize: density.note, color: colors.muted, fontVariant: ["tabular-nums"] }}>{(row() as { detail: string }).detail}</Text>
              </View>
            }
          >
            <View
              style={{ height: HEADING, justifyContent: "center", paddingHorizontal: GUTTER, backgroundColor: colors.inset, borderBottomWidth: 1, borderBottomColor: colors.line }}
            >
              <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", color: colors.muted }}>Week {(row() as { week: number }).week}</Text>
            </View>
          </If>
        )}
      </List>
      <View testID="footer" style={{ alignItems: "center", gap: 6, paddingTop: 32, paddingBottom: 48, paddingHorizontal: 16 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>That's all 160 entries</Text>
        <Text style={{ fontSize: 13, color: colors.muted, textAlign: "center" }}>
          A footer after the list: the list keeps only the rows near the screen, at its full length in the page.
        </Text>
      </View>
    </Scroll>
  );
}
