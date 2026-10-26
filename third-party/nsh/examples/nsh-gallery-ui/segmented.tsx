import { effect, signal, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { Tab, Tabs } from "nsh/base";
import { colors, finish, motion } from "./theme";

/**
 * Equal segments with an indicator that springs to the selected one
 * (`count` shows a quiet number after a label): `nsh/base`'s `Tabs`, a tab
 * per segment, in the gallery's look.
 */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  size?: "small" | "regular";
}) {
  const width = signal(0);
  const x = createAnimatedValue(0);
  const index = () => Math.max(0, props.options.findIndex((o) => o.value === props.value));
  // The track's border and padding: the indicator is placed inside the
  // border (an absolute child's containing block is the padding box), so
  // the segments share what is left of the measured width after both.
  const border = 1;
  const inset = 3;
  const segment = () => (width() - 2 * (border + inset)) / Math.max(1, props.options.length);
  const height = props.size === "small" ? 32 : 40;
  // The first placement jumps; later ones spring.
  let placed = false;
  effect(() => {
    const to = index() * segment();
    if (width() <= 0) return;
    if (placed) x.spring(to, motion.settle);
    else x.set(to);
    placed = true;
  });
  return (
    <Tabs
      onLayout={(e) => width.set(e.size.width)}
      style={{
        height,
        flexDirection: "row",
        padding: inset,
        borderRadius: height / 2,
        backgroundColor: colors.inset,
        boxShadow: finish.track.boxShadow,
        borderWidth: border,
        borderColor: colors.border,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: inset,
          left: inset,
          bottom: inset,
          width: segment(),
          borderRadius: (height - 2 * (border + inset)) / 2,
          ...finish.pill,
          borderWidth: 1,
          transform: [{ translateX: x }],
        }}
      />
      <Each of={props.options}>
        {(option) => (
          <Tab
            selected={props.value === option().value}
            onPress={() => props.onChange(option().value)}
            style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: props.size === "small" ? 13 : 14,
                fontWeight: "500",
                color: props.value === option().value ? colors.text : colors.muted,
              }}
            >
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
