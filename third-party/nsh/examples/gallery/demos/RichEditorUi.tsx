// The Rich Editor demo's toolbar controls, with Lucide's icons, on the
// shared gallery UI's colors and finishes.
import { View } from "nsh";
import { Button as BaseButton, Toggle as BaseToggle, ToggleGroup as BaseToggleGroup } from "nsh/base";
import { colors, finish, focusRing } from "../ui";
import { LucideIcon, type LucideIconName } from "../icons";

export { LucideIcon, type LucideIconName } from "../icons";

/** An item of a {@link ToggleGroup}: its icon, and the label screen readers say and its tooltip shows. */
export type ToggleItem<T extends string> = { value: T; icon: LucideIconName; label: string; disabled?: boolean };

/**
 * A row of icon toggles on one track (shadcn's toggle group): `single` keeps
 * at most one pressed, `multiple` any. The track is `nsh/base`'s
 * `ToggleGroup` (a toolbar, one Tab stop whose arrow keys move the focus)
 * and each item its `Toggle`, so screen readers (and tests) read its pressed
 * state.
 */
export function ToggleGroup<T extends string>(props: {
  type: "single" | "multiple";
  items: readonly ToggleItem<T>[];
  /** The pressed values. */
  value: readonly T[];
  /** The value pressed or released, and whether it is now pressed. */
  onToggle: (value: T, pressed: boolean) => void;
  testID?: string;
}) {
  return (
    <BaseToggleGroup
      testID={props.testID}
      style={{ flexDirection: "row", padding: 2, gap: 2, borderRadius: 9, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.border }}
    >
      <Each of={props.items}>
        {(item) => {
          const pressed = () => props.value.includes(item().value);
          return (
            <View tooltip={item().label}>
              <BaseToggle
                pressed={pressed()}
                disabled={item().disabled}
                accessibilityLabel={item().label}
                onChange={({ pressed: next }) => props.onToggle(item().value, next)}
                hoverStyle={item().disabled || pressed() ? undefined : { backgroundColor: colors.raised }}
                focusStyle={focusRing(1)}
                style={{
                  width: 30,
                  height: 28,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: item().disabled ? 0.35 : 1,
                  ...(pressed() ? { ...finish.pill, borderWidth: 1 } : { borderWidth: 1, borderColor: "transparent" }),
                }}
              >
                <LucideIcon name={item().icon} size={16} tint={pressed() ? colors.text : colors.muted} />
              </BaseToggle>
            </View>
          );
        }}
      </Each>
    </BaseToggleGroup>
  );
}

/** A square icon button for toolbars: its label is what screen readers say and its tooltip. */
export function IconButton(props: { icon: LucideIconName; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View tooltip={props.label}>
      <BaseButton
        disabled={props.disabled}
        accessibilityLabel={props.label}
        onPress={props.onPress}
        hoverStyle={props.disabled ? undefined : { backgroundColor: colors.raised }}
        focusStyle={focusRing(1)}
        style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", opacity: props.disabled ? 0.35 : 1 }}
      >
        <LucideIcon name={props.icon} size={16} tint={colors.text} />
      </BaseButton>
    </View>
  );
}

/** A thin vertical line between a toolbar's groups. */
export function ToolbarSeparator() {
  return <View style={{ width: 1, height: 20, marginHorizontal: 4, backgroundColor: colors.border }} />;
}
