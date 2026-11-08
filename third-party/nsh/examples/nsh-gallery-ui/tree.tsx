// The rows of a `Tree`, as the gallery's and the website's trees draw them:
// a chevron that turns as the folder opens, a folder that opens with it,
// the label indented by the item's depth. Every state is the row's class
// (`group` in `treeItemClass`), so the drawing is made once per item and
// the chevron turns with a transition, still with reduced motion.
import { Text, View } from "nsh";
import type { TreeEntry } from "nsh/base";
import { desktop, size } from "./demo";
import { Icon, type IconName } from "./icons";
import { colors, TERMINAL_COLUMN, TERMINAL_GAP, terminal } from "./theme";

/**
 * A row: quiet until hovered, the selected one tinted in the brand color
 * with its label in the strong text color (a color, not a weight: the
 * labels keep their widths), the keyboard's ring while the tree has the
 * focus, disabled ones dimmed.
 * The ring is drawn inside the row: the rows fill the list's width, whose
 * scroll view clips what reaches past its sides.
 */
export const treeItemClass =
  "group rounded-md transition-colors duration-150 motion-reduce:transition-none hover:bg-hover active:opacity-70 " +
  "selected:bg-brand-tint focus:outline-2 focus:-outline-offset-2 focus:outline-ring disabled:opacity-40";

/** How far each level is indented, in points. */
export const treeIndent = 14;

/**
 * A row's content: its chevron (folders), its icon (`icon`, else a folder
 * that opens with it or a file), its label and a `detail` at the end.
 */
export function TreeRow(props: { entry: TreeEntry; icon?: IconName; tint?: string; detail?: string }) {
  if (terminal) return <TerminalTreeRow {...props} />;
  // Compact with a pointer; a 44-point target on a touch screen.
  const height = desktop ? size.rowSm - 4 : size.rowSm;
  return (
    <View style={{ height, flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8, paddingLeft: 4 + props.entry.depth * treeIndent }}>
      <View
        class="transition-transform duration-200 ease-out motion-reduce:transition-none group-aria-expanded:rotate-90"
        style={{ width: 14, height: 14, opacity: props.entry.folder ? 1 : 0 }}
      >
        <Icon name="chevron" size={14} tint={colors.muted} />
      </View>
      {props.icon ? (
        <Icon name={props.icon} size={16} tint={props.tint ?? colors.muted} />
      ) : props.entry.folder ? (
        <View style={{ width: 16, height: 16 }}>
          <View class="group-aria-expanded:hidden">
            <Icon name="folder" size={16} tint={colors.muted} />
          </View>
          <View class="hidden group-aria-expanded:flex">
            <Icon name="folder-open" size={16} tint={colors.muted} />
          </View>
        </View>
      ) : (
        <Icon name="file" size={16} tint={colors.muted} />
      )}
      <Text
        class="flex-1 text-muted-foreground group-selected:text-foreground"
        style={{ fontSize: desktop ? 13 : size.label, numberOfLines: 1 }}
      >
        {props.entry.label}
      </Text>
      {props.detail ? <Text style={{ fontSize: size.detail, color: colors.faint }}>{props.detail}</Text> : null}
    </View>
  );
}

/**
 * A row in a terminal: two columns a level, then the folder's own mark
 * (`▸ ` closed, `▾ ` open, from the row's expanded state) or two blank
 * columns on a leaf, so a level's labels line up and a child's mark sits
 * under its parent's label; no icons. The row draws its marks itself, so
 * the core adds none (a marked first text, or a leading empty box).
 */
function TerminalTreeRow(props: { entry: TreeEntry; detail?: string }) {
  const indent = props.entry.depth * 2 * TERMINAL_COLUMN;
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {indent > 0 ? <View style={{ width: indent, flexShrink: 0 }} /> : null}
      {props.entry.folder ? (
        <>
          <Text class="text-muted-foreground group-aria-expanded:hidden">▸ </Text>
          <Text class="hidden text-muted-foreground group-aria-expanded:flex">▾ </Text>
        </>
      ) : (
        <View style={{ width: 2 * TERMINAL_COLUMN, flexShrink: 0 }} />
      )}
      <Text class="flex-1 text-muted-foreground group-selected:text-foreground" style={{ numberOfLines: 1 }}>
        {props.entry.label}
      </Text>
      {props.detail ? <Text style={{ marginLeft: TERMINAL_GAP, color: colors.faint }}>{props.detail}</Text> : null}
    </View>
  );
}
