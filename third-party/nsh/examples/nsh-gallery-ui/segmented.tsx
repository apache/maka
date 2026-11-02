import { platform, Text } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { colors, finish } from "./theme";

/**
 * Segments with a raised thumb that springs to the selected one (`count`
 * shows a quiet number after a label): `nsh/base`'s `Tabs`, a tab per
 * segment, in the gallery's look. With a pointer it is as wide as its
 * labels (30 points high, 12-point type, the thumb's corners 6 and the
 * track's 9); on a touch screen, or with `fill`, it spans the row and its
 * segments share it equally, their labels centered.
 *
 * The thumb is the list's indicator: the core places it on the selected
 * tab and springs it to the next one natively, as its own frame alone, so
 * what the value shows (a page's content) changes at once in the same
 * commit, and with reduced motion it moves at once too.
 */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  size?: "small" | "regular";
  fill?: boolean;
}) {
  const pointer = platform.desktop;
  const spread = !pointer || !!props.fill;
  // The track's padding: the thumb sits inside it.
  const inset = 2;
  const height = pointer ? (props.size === "small" ? 26 : 30) : props.size === "small" ? 32 : 36;
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
        borderWidth: 1,
        borderColor: finish.track.borderColor,
      }}
      indicatorStyle={{
        top: inset,
        bottom: inset,
        borderRadius: pointer ? 6 : 7,
        borderCurve: "continuous",
        borderWidth: 1,
        ...finish.raised,
      }}
    >
      <Each of={props.options}>
        {(option) => (
          <Tab
            selected={props.value === option().value}
            onPress={() => {
              if (option().value !== props.value) props.onChange(option().value);
            }}
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
                color: props.value === option().value ? colors.text : colors.muted,
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
