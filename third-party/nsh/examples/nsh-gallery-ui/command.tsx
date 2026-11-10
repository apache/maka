// A `Command`'s parts as the gallery's and the website's palettes draw
// them: a card with a search bar ruled off from the rows, quiet section
// headings, hairline separators, rows tinted in the brand color while
// highlighted, and the shortcut's keys at the end of a row. Every state is
// the row's class (`group` in `commandClasses.item`), so a row's drawing is
// made once per item and the highlight moves without drawing anything.
import { Text, View } from "nsh";
import type { CommandEntry, CommandGroup } from "nsh/base";
import { desktop, size } from "./demo";
import { Icon, type IconName } from "./icons";
import { colors, terminal } from "./theme";

/**
 * The classes of a palette's parts. The highlight is a tint and an inner
 * border, both inside the row: the rows fill the list's width, whose scroll
 * view clips what reaches past its sides.
 */
export const commandClasses = {
  /** The palette's frame. */
  root: "overflow-hidden rounded-xl border border-border bg-card",
  /**
   * The row of the search icon, the field and the spinner. A terminal's
   * field is a raised band: the band spans the row, as the rows' do, and
   * its own padding sets its text where theirs starts.
   */
  searchBar: `flex-row items-center gap-2 border-b border-border ${terminal ? "" : "px-3"}`,
  /** The search field. */
  search: `flex-1 ${terminal ? "px-2 " : ""}${desktop ? "h-11 text-sm" : "h-12 text-base"} text-foreground placeholder:text-faint`,
  /**
   * The scroll view of the rows. A terminal's rows set their text off
   * the edge with their own padding, as the field does.
   */
  list: terminal ? "" : "p-1.5",
  /** A section's header. */
  group: "px-2 pt-2.5 pb-1",
  /** Between two sections. */
  separator: "-mx-1.5 my-1 h-px bg-border",
  /** A row: quiet until hovered, tinted while highlighted, dimmed while disabled. */
  item:
    "group rounded-md border border-transparent transition-colors duration-100 motion-reduce:transition-none " +
    "hover:bg-hover focus:border-brand/30 focus:bg-brand-tint active:opacity-70 disabled:opacity-40",
};

/** A shortcut's keys, as hints show them here (`entry.shortcutLabel`). */
export function CommandKeys(props: { label: string }) {
  return (
    <View
      class="rounded border border-border bg-raised px-1.5"
      style={{ height: 20, justifyContent: "center" }}
    >
      <Text style={{ fontSize: 11, fontWeight: "500", color: colors.muted, fontVariant: ["tabular-nums"] }}>{props.label}</Text>
    </View>
  );
}

/** A section's heading: small capitals in the faint color. */
export function CommandHeading(props: { group: CommandGroup }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 0.6, color: colors.faint }}>
      {props.group.heading.toUpperCase()}
    </Text>
  );
}

/**
 * A row's content: an icon, the label (and a `detail` under it), a `note`
 * at the end, the shortcut's keys with a pointer, and a check for the
 * item in effect. The icon and label take the brand color while
 * highlighted (`group-focus:`).
 */
export function CommandRow(props: { entry: CommandEntry; icon?: IconName; detail?: string; note?: string }) {
  const height = props.detail ? size.row : size.rowSm;
  return (
    <View style={{ height, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8 }}>
      {props.icon ? <Icon name={props.icon} size={16} tint={colors.muted} /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ fontSize: desktop ? 13 : size.label, color: colors.text, numberOfLines: 1 }}>{props.entry.label}</Text>
        {props.detail ? (
          <Text style={{ fontSize: size.detail, color: colors.muted, numberOfLines: 1 }}>{props.detail}</Text>
        ) : null}
      </View>
      {props.note ? <Text style={{ fontSize: size.detail, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text> : null}
      {desktop && props.entry.shortcutLabel ? <CommandKeys label={props.entry.shortcutLabel} /> : null}
      {props.entry.checked ? <Icon name="check" size={14} tint={colors.text} /> : null}
    </View>
  );
}

/** What a palette shows while nothing matches. */
export function CommandEmpty(props: { label: string }) {
  return <Text style={{ paddingVertical: 24, textAlign: "center", fontSize: 13, color: colors.muted }}>{props.label}</Text>;
}
