import { LayoutAnimation, platform, reduceMotion, signal, Text, View } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { colors, finish } from "./theme";

/**
 * Segments with a raised thumb that springs to the selected one (`count`
 * shows a quiet number after a label): `nsh/base`'s `Tabs`, a tab per
 * segment, in the gallery's look. With a pointer it is as wide as its
 * labels (30 points high, 12-point type, the thumb's corners 6 and the
 * track's 9); on a touch screen, or with `fill`, it spans the row and its
 * segments share it equally, their labels centered.
 */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  size?: "small" | "regular";
  fill?: boolean;
}) {
  const pointer = platform.idiom === "desktop";
  const spread = !pointer || !!props.fill;
  // Where each segment lies in the track, as the tabs report it.
  const spans = signal<{ x: number; width: number }[]>([]);
  // The segment pressed, until the app has the value: the thumb moves in a
  // commit of its own, so the layout animation springs it alone and what
  // the value shows (a page's content) appears at once in the next one.
  const pending = signal<T | null>(null);
  const selected = () => pending() ?? props.value;
  const index = () => Math.max(0, props.options.findIndex((o) => o.value === selected()));
  // The track's border and padding: the thumb is placed inside the border
  // (an absolute child's containing block is the padding box), the tabs'
  // origins are from the border's outer edge.
  const border = 1;
  const inset = 2;
  const height = pointer ? (props.size === "small" ? 26 : 30) : props.size === "small" ? 32 : 36;
  const thumb = () => spans()[index()] ?? { x: border + inset, width: 0 };
  const measure = (i: number, x: number, width: number) => {
    const next = spans().slice();
    next[i] = { x, width };
    spans.set(next);
  };
  return (
    <Tabs
      style={{
        height,
        flexDirection: "row",
        alignSelf: spread ? "stretch" : "flex-start",
        padding: inset,
        borderRadius: pointer ? 9 : 10,
        borderCurve: "continuous",
        backgroundColor: colors.track,
        boxShadow: finish.track.boxShadow,
        borderWidth: border,
        borderColor: finish.track.borderColor,
      }}
    >
      <View
        style={{
          pointerEvents: "none",
          position: "absolute",
          top: inset,
          bottom: inset,
          // A layout animation springs it to the next segment (`onPress`).
          left: thumb().x - border,
          width: thumb().width,
          borderRadius: pointer ? 6 : 7,
          borderCurve: "continuous",
          borderWidth: 1,
          ...finish.raised,
        }}
      />
      <Each of={props.options}>
        {(option, i) => (
          <Tab
            selected={selected() === option().value}
            onPress={() => {
              const value = option().value;
              if (value === selected()) return;
              if (reduceMotion()) return props.onChange(value);
              LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
              pending.set(value);
              setTimeout(() => {
                pending.set(null);
                props.onChange(value);
              }, 0);
            }}
            onLayout={({ bounds }) => measure(i(), bounds.origin.x, bounds.size.width)}
            style={{
              ...(spread ? { flex: 1, paddingHorizontal: 8 } : { paddingHorizontal: 10 }),
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            <Text
              style={{
                numberOfLines: 1,
                fontSize: pointer ? 12 : props.size === "small" ? 13 : 14,
                fontWeight: "500",
                color: selected() === option().value ? colors.text : colors.muted,
              }}
            >
              {option().label}
            </Text>
            <If when={option().count !== undefined}>
              <Text style={{ fontSize: pointer ? 11 : 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{option().count}</Text>
            </If>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}
