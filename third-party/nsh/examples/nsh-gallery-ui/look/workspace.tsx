// What the workspace components look like, shared by the gallery's
// Resizable, Dock, Editor, RichEditor and TextView demos and by the
// website's demos (through `demo.ts`): resize handles, a dock's parts and
// tabs, a diff's actions on a change, a rich editor's document and a text
// view's links.
import type { JSX } from "nsh";
import { platform, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Icon, type IconName } from "../icons";
import { colors, finish, terminal } from "../theme";
import { buttonGlyph, buttonLabel, buttonLook, type ButtonKind } from "./button";

/**
 * The thumb of a resize handle (`handleThumbClass`), as gpui-component
 * draws it: none at rest, so the hairlines stay quiet; a faint pill grows
 * in under the pointer, and a long solid one while pressed or dragged.
 */
export const handleThumb =
  "h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition duration-150 ease-out group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100";

/** A resize handle's hairline, which stays as it is (its thumb shows where
 * to drag): `across` a row of panels, `along` a column. */
export const resizableHandle = { across: "h-full w-px bg-border", along: "h-px w-full bg-border", thumb: handleThumb };

/** A `ResizablePanelGroup`'s handles (spread it): the hairline across a
 * `horizontal` group's row, along a `vertical` one's column, and the
 * thumb. */
export function resizableHandleLook(axis: "horizontal" | "vertical") {
  return { handleClass: axis === "horizontal" ? resizableHandle.across : resizableHandle.along, handleThumbClass: handleThumb };
}

/**
 * A `DockArea`'s parts (spread it): groups and docks on the inset, a tab
 * bar over a hairline (its tabs drawn by `DockTab`), the handles' hairlines
 * and thumbs, a drop target edged and tinted in the brand color, the
 * compact presentation's drawer and sheet on the card's surface over the
 * theme's `scrim`, every modal's backdrop.
 */
export const dockClasses = {
  groupClass: "flex-1 bg-inset",
  tabBarClass: "flex-row gap-1 border-b border-line",
  tabClass: "group",
  contentClass: "flex-1",
  handleClass: "basis-px bg-line",
  handleThumbClass: handleThumb,
  dockClass: "bg-inset",
  dropIndicatorClass: "rounded-lg border-2 border-brand bg-brand-tint",
  drawerClass: "border-r border-border bg-card",
  sheetClass: "rounded-t-2xl border-t border-border bg-card",
  backdropClass: "bg-scrim",
};

/**
 * A dock's tab (what `renderTab` returns, in a `dockClasses` tab): its
 * title sized to it, as wide on either side, muted until the pointer is on
 * it; the shown tab's title in the text color, underlined in the brand
 * color. `children` follow the title (a close button, `dockTabCloseClass`).
 */
export function DockTab(props: { title: string; active: boolean; testID?: string; children?: JSX.Element }) {
  return (
    <View testID={props.testID} class="h-9 flex-row items-center gap-1 px-3">
      <Text
        style={{ numberOfLines: 1 }}
        class={`max-w-40 text-[13px] font-medium transition-colors ${props.active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}
      >
        {props.title}
      </Text>
      {props.children}
      <If when={props.active}>
        <View style={{ pointerEvents: "none" }} class="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-brand" />
      </If>
    </View>
  );
}

/**
 * A dock tab's close button (`class`), its glyph `×` muted text: with a
 * pointer it fades in over the tab's end while the pointer is on the tab;
 * a touch screen keeps it beside the title (show it on the shown tab); a
 * terminal's tab, with no room at its end, sets it beside the title, shown
 * while the pointer is on the tab.
 */
export const dockTabCloseClass = terminal
  ? "size-5 items-center justify-center opacity-0 group-hover:opacity-100"
  : platform.desktop
    ? "absolute right-1 top-2 size-5 items-center justify-center rounded-md bg-inset opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised"
    : "-mr-1.5 size-5 items-center justify-center rounded-md active:opacity-70";

/** A dragged tab's preview (what `renderDragPreview` returns): its title on a raised chip. */
export function DockDragPreview(props: { title: string }) {
  return (
    <View class="rounded-lg border border-border px-3 py-1.5" style={{ backgroundColor: colors.raised, ...finish.raised }}>
      <Text class="text-[13px] font-medium text-foreground">{props.title}</Text>
    </View>
  );
}

/**
 * A `RichEditor`'s document (its `classes`): roomy padding inside the
 * scroll view, so its scroll bar runs along the editor's edge; relaxed
 * paragraphs, tight large headings, a quiet quote, code on the muted fill,
 * indented lists, task checkboxes filled with the primary once checked,
 * brand-colored links. NSH's editor draws nothing of its own.
 */
export const richEditorClasses = {
  content: "gap-3 px-6 py-5",
  placeholder: "text-muted-foreground",
  listMarker: "text-muted-foreground",
  taskCheckbox: "size-4 mr-2 mt-1 rounded border border-border checked:bg-primary checked:border-primary",
  nodes: {
    paragraph: "leading-relaxed",
    "heading[level=1]": "text-3xl font-bold tracking-tight",
    "heading[level=2]": "text-2xl font-semibold tracking-tight",
    "heading[level=3]": "text-xl font-semibold",
    blockquote: "border-l-4 border-border pl-4 text-muted-foreground italic",
    codeBlock: "font-mono text-sm bg-muted rounded-lg px-4 py-3",
    bulletList: "gap-1.5 pl-6",
    orderedList: "gap-1.5 pl-6",
    taskList: "gap-1.5",
    horizontalRule: "h-px bg-border my-3",
    tableHeader: "font-semibold",
  },
  marks: {
    bold: "font-bold",
    italic: "italic",
    code: "font-mono text-sm bg-muted rounded px-1",
    link: "text-brand underline",
    strike: "line-through",
  },
};

/** A `TextView`'s links (its `classes`): the brand color over a faint
 * underline of it. */
export const textViewLinkClasses = { link: "text-brand decoration-brand/40" };

/** A streaming `TextView`'s caret (a view of this class, its
 * `streamingCaret`): a brand-colored block a line high that pulses. */
export const textViewCaretClass = "ml-0.5 h-4 w-2 animate-pulse rounded-sm bg-brand";

/** One action on a diff's change: a chip 20 points high, its label 11
 * points in the interface's font (the diff's text is monospaced), or only
 * its icon, 20 points square. */
function HunkAction(props: { kind: ButtonKind; label: string; icon: IconName; index: number; iconOnly?: boolean; onPress: () => void }) {
  const look = buttonLook(props.kind, {
    size: "small",
    style: () => (terminal ? undefined : { height: 20, minWidth: 20, borderRadius: 5, paddingHorizontal: props.iconOnly ? 0 : 6 }),
  });
  return (
    <Button onPress={props.onPress} accessibilityLabel={`${props.label} change ${props.index + 1}`} {...look}>
      {props.iconOnly && !terminal ? (
        <Icon {...buttonGlyph(props.kind, { size: "small" })} name={props.icon} size={11} />
      ) : (
        <Text class="font-sans" style={{ ...buttonLabel(props.kind, { size: "small" }), fontSize: terminal ? undefined : 11 }}>
          {props.label}
        </Text>
      )}
    </Button>
  );
}

/**
 * A `DiffView`'s actions on a change (what `renderHunkActions` returns):
 * Revert, secondary, and Keep, the primary citrus, as compact chips over
 * the end of the change's first row, so they cover as little code as they
 * can (gpui-component's diff); `iconOnly`, for a narrow view, shows their
 * icons (undo, check), named for screen readers ("Revert change 2").
 */
export function DiffHunkActions(props: { index: number; iconOnly?: boolean; onRevert: () => void; onKeep: () => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      <HunkAction kind="secondary" label="Revert" icon="undo" index={props.index} iconOnly={props.iconOnly} onPress={props.onRevert} />
      <HunkAction kind="primary" label="Keep" icon="check" index={props.index} iconOnly={props.iconOnly} onPress={props.onKeep} />
    </View>
  );
}
