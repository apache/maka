// What an accordion's and a collapsible's parts look like, shared by the
// gallery's Accordion and Collapsible demos and by the website's demos
// (through `demo.ts`): the trigger, a row of the list (`listRow`), the
// chevron that turns as it opens and the panel under it.
import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { Icon } from "../icons";
import { colors } from "../theme";
import { controlSize, listRow, type ListRowOptions } from "./surface";

/** Options of `disclosureTriggerLook`: a row's (`listRow`). */
export type DisclosureTriggerOptions = ListRowOptions;

/**
 * A trigger's props (spread them on an `AccordionTrigger`, or on the row
 * that flips a `Collapsible`): the list's row (`listRow`: its height, the
 * `accent` hover fill reaching past the content, pressed, focus and disabled
 * states; a `RowDivider` among its children above all but the first), with
 * the `group` class, so an accordion's `DisclosureChevron` turns with
 * `group-aria-expanded:`.
 */
export function disclosureTriggerLook(o?: DisclosureTriggerOptions) {
  const row = listRow(o);
  return {
    class: "group",
    get style(): ViewStyle {
      return row.style;
    },
    get hoverStyle(): ViewStyle | undefined {
      return row.hoverStyle;
    },
    get activeStyle(): ViewStyle {
      return row.activeStyle;
    },
    get focusStyle(): ViewStyle {
      return row.focusStyle;
    },
    get disabledStyle(): ViewStyle {
      return row.disabledStyle;
    },
  };
}

/**
 * The chevron at a trigger's trailing edge, muted, the size of a row's
 * icons (`controlSize.check`). A collapsible's (default) points along the
 * row and turns down as it opens (`open`), in a lane as wide as its stroke
 * (half its box), so it ends where the values below it end. An accordion's
 * (`accordion`) points down and turns up with its trigger's `aria-expanded`
 * (the trigger's `group` class), in its whole box. Both turn on a short
 * transition, at once with reduced motion.
 */
export function DisclosureChevron(props: { open?: boolean; accordion?: boolean }) {
  const icon = controlSize.check;
  return props.accordion ? (
    <View
      class="transition-transform duration-200 motion-reduce:transition-none group-aria-expanded:rotate-180"
      style={{ width: icon, height: icon, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="chevron-down" size={icon} tint={colors.muted} />
    </View>
  ) : (
    <View class="transition-transform duration-150 motion-reduce:transition-none" style={{ width: icon / 2, alignItems: "center", rotate: props.open ? "90deg" : "0deg" }}>
      <Icon name="chevron" size={icon} tint={colors.muted} />
    </View>
  );
}

/** Options of `disclosurePanel`. */
export interface DisclosurePanelOptions {
  /** Room before the content: to line it up with the title, past a leading icon. */
  start?: number;
  /** The gap between its lines, default 6. */
  gap?: number;
}

/**
 * A panel's content under its trigger (a view inside an `AccordionPanel`, or
 * a `Collapsible`'s `content`): padded at the bottom, 12 points with a
 * pointer, 14 on a touch screen. The padding is the content's, not the
 * panel's: a revealed panel is zero high while closed.
 */
export function disclosurePanel(o?: DisclosurePanelOptions): ViewStyle {
  return { paddingStart: o?.start ?? 0, paddingBottom: controlSize.padding + 6, gap: o?.gap ?? 6 };
}
