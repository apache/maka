// The Rich Editor demo's toolbar controls, with Lucide's icons, on the
// shared gallery UI's colors and finishes. A terminal draws no icons: each
// control shows its `short` label there (its label when unset), as text,
// sized to it and two columns from the next.
import { Text, View } from "nsh";
import { Button as BaseButton, Toggle as BaseToggle, ToggleGroup as BaseToggleGroup } from "nsh/base";
import { colors, focusRing, ghostFill, terminal, TERMINAL_GAP, toggleGlyph, toggleLabel, toggleLook } from "../ui";
import { LucideIcon, type LucideIconName } from "../icons";

export { LucideIcon, type LucideIconName } from "../icons";

/** An item of a {@link ToggleGroup}: its icon, and the label screen readers say and its tooltip shows. */
export type ToggleItem<T extends string> = { value: T; icon: LucideIconName; label: string; short?: string; disabled?: boolean };

/** The gap between a toolbar's controls: two columns in a terminal, where each is its label. */
export const TOOL_GAP = terminal ? TERMINAL_GAP : 2;

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
      style={{ flexDirection: "row", padding: 2, gap: TOOL_GAP, borderRadius: 9, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.border }}
    >
      <Each of={props.items}>
        {(item) => {
          const pressed = () => props.value.includes(item().value);
          // The toggles' shared look: bare while off, `finish.on` while pressed.
          const look = { disabled: () => item().disabled };
          return (
            <View tooltip={item().label}>
              <BaseToggle
                pressed={pressed()}
                disabled={item().disabled}
                accessibilityLabel={item().label}
                onChange={({ pressed: next }) => props.onToggle(item().value, next)}
                {...toggleLook(look)}
              >
                <If when={terminal} else={<LucideIcon name={item().icon} {...toggleGlyph(pressed, look)} />}>
                  <Text style={toggleLabel(pressed, look)}>{item().short ?? item().label}</Text>
                </If>
              </BaseToggle>
            </View>
          );
        }}
      </Each>
    </BaseToggleGroup>
  );
}

/**
 * A square icon button for toolbars: its label is what screen readers say and its tooltip. In a terminal it is
 * its label in the muted color on no band, as the toolbar's toggles that are off are, so the tools read as one row
 * (a ghost button's band, {@link ghostFill}, would set it apart as if pressed).
 */
export function IconButton(props: { icon: LucideIconName; label: string; short?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View tooltip={props.label}>
      <BaseButton
        disabled={props.disabled}
        accessibilityLabel={props.label}
        onPress={props.onPress}
        hoverStyle={props.disabled ? undefined : { backgroundColor: colors.raised }}
        focusStyle={focusRing(1)}
        style={{ width: terminal ? undefined : 32, height: terminal ? undefined : 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: terminal ? undefined : ghostFill(), opacity: props.disabled ? 0.35 : 1 }}
      >
        <If when={terminal} else={<LucideIcon name={props.icon} size={16} tint={colors.text} />}>
          <Text style={{ color: colors.muted }}>{props.short ?? props.label}</Text>
        </If>
      </BaseButton>
    </View>
  );
}

/** A thin vertical line between a toolbar's groups. */
export function ToolbarSeparator() {
  return <View style={{ width: 1, height: 20, marginHorizontal: 4, backgroundColor: colors.border }} />;
}
