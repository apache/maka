import { Text } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { play } from "./sound";
import { colors, TERMINAL_ROW, terminal } from "./theme";
import { segmentedLook } from "./look/tabs";

/**
 * Segments with a raised thumb that springs to the selected one (`count`
 * shows a quiet number after a label): `nsh/base`'s `Tabs`, a tab per
 * segment, in `segmentedLook`. With a pointer it is as wide as its labels
 * (30 points high, 12-point type, the thumb's corners 6 and the track's 9);
 * on a touch screen, or with `fill`, it spans the row and its segments
 * share it equally, their labels centered. The terminal shows the segments
 * on one row as wide as their words (`fill` too), the selected one as its
 * selection, without the track.
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
  if (terminal) {
    return (
      <Tabs style={{ height: TERMINAL_ROW, flexDirection: "row" }}>
        <Each of={props.options}>
          {(option) => (
            <Tab
              selected={props.value === option().value}
              onPress={() => {
                if (option().value !== props.value) {
                  play("select");
                  props.onChange(option().value);
                }
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text style={{ numberOfLines: 1, fontSize: 13, fontWeight: "500", color: props.value === option().value ? colors.text : colors.muted }}>
                {option().label}
              </Text>
              <If when={option().count !== undefined}>
                <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{option().count}</Text>
              </If>
            </Tab>
          )}
        </Each>
      </Tabs>
    );
  }
  // The size and `fill` are read once, as a control's shape is.
  const look = segmentedLook({ size: props.size, fill: props.fill });
  return (
    <Tabs style={look.style} indicatorStyle={look.indicatorStyle}>
      <Each of={props.options}>
        {(option) => (
          <Tab
            selected={props.value === option().value}
            onPress={() => {
              if (option().value !== props.value) {
                  play("select");
                  props.onChange(option().value);
                }
            }}
            {...look.segment({ selected: () => props.value === option().value })}
          >
            <Text style={look.label(props.value === option().value)}>{option().label}</Text>
            <If when={option().count !== undefined}>
              <Text style={look.count}>{option().count}</Text>
            </If>
          </Tab>
        )}
      </Each>
    </Tabs>
  );
}
