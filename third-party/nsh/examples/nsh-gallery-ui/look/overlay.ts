// What the overlays look like: a tooltip's bubble, a popover's and a hover
// card's surface, a sheet's panel and grabber, a card dialog, a toast and
// its action, and the scrim behind what is modal. Shared by the gallery's
// `Tip`, `Sheet` and toasts and its overlay demos, and by the website's
// demos (through `demo.ts`).
import type { TextStyle, ViewStyle } from "nsh";
import { keyboardFrame, platform, safeArea, token, windowSize } from "nsh";
import { popupSurface } from "../popup";
import { alpha, colors, finish, focusRing, hovered, radius, terminal } from "../theme";
import { buttonLabel, buttonLook, type ButtonLookOptions } from "./button";
import { pressSink, pressTransition } from "./press";

const pointer = platform.desktop;

/**
 * The scrim behind what is modal (a sheet, a dialog, a menu's sheet on a
 * touch screen): the theme's `scrim`, one dimming for every overlay. Pass
 * it as the overlay's `backdropStyle`.
 */
export function backdrop(): ViewStyle {
  return { backgroundColor: token("scrim") };
}

/** Options of `tooltipLook`. */
export interface TooltipLookOptions {
  /** More than a line (a title, a list): 10 points of padding, its rows 8 apart, larger corners. */
  rich?: boolean;
}

/**
 * A tooltip's bubble (`class`, on the view inside `nsh/base`'s `Tooltip`):
 * the theme's `popover` surface with the border's edge, not the text's
 * color inverted, so it reads as the menus and popovers do in both
 * appearances. One line: a row 8 points apart, 8 by 4 points of padding,
 * 6-point corners; `rich`: a column, 10 points of padding, 8-point corners.
 * Its text takes `tooltipText`, a shortcut or a note `tooltipNote`.
 */
export function tooltipLook(o?: TooltipLookOptions) {
  return {
    class: o?.rich
      ? "gap-2 rounded-lg border border-border bg-popover p-2.5"
      : "flex-row items-center gap-2 rounded-md border border-border bg-popover px-2 py-1",
  };
}

/** A tooltip's text (`class`): 12 points in the popover's foreground. */
export const tooltipText = "text-xs text-popover-foreground";

/** A tooltip's quieter text (`class`): a shortcut's keys, a time. */
export const tooltipNote = "text-xs text-muted-foreground";

/** Options of `popoverLook`. */
export interface PopoverLookOptions {
  /** Its width; unset, as wide as its content. */
  width?: number;
  /** A small note (a line or two): 12 points of padding, its rows 4 apart. */
  compact?: boolean;
}

/**
 * A popover's or a hover card's surface (the `style` of the `PopIn` it
 * comes in with): the popup surface every menu shares (`popupSurface`:
 * `finish.menu`'s fill, edge and soft shadow, 10-point corners), 14 points
 * of padding with a pointer and 16 on a touch screen, its rows 12 apart.
 */
export function popoverLook(o?: PopoverLookOptions): ViewStyle {
  const room: ViewStyle = o?.compact ? { padding: 12, gap: 4 } : { padding: pointer ? 14 : 16, gap: 12 };
  return { ...popupSurface(), ...room, width: o?.width };
}

/** The edge of the screen a sheet comes from. */
export type SheetSide = "bottom" | "top" | "left" | "right";

/**
 * A sheet's panel (`nsh/base`'s `Sheet`'s `popupStyle`): the card's
 * surface with the border's edge. At the bottom (or the top) it spans the
 * width, its two inner corners 20 points round, 16 points of padding at its
 * sides and its rows 14 apart, kept above the keyboard and the home
 * indicator, and never taller than the screen below the status bar; put
 * `sheetGrabber` first in a bottom one. At the left or the right it is the
 * full height, at most 360 points wide (48 short of a narrow window), its
 * inner corners 16 round, 20 points of padding inside the safe area.
 */
export function sheetPanel(side: SheetSide): ViewStyle {
  const surface: ViewStyle = { backgroundColor: colors.surface, borderColor: colors.border };
  if (side === "bottom" || side === "top") {
    const bottom = side === "bottom";
    return {
      ...surface,
      borderWidth: 1,
      ...(bottom
        ? { borderBottomWidth: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8 }
        : { borderTopWidth: 0, borderBottomLeftRadius: 20, borderBottomRightRadius: 20, paddingTop: safeArea().top + 16, paddingBottom: 20 }),
      borderCurve: "continuous",
      maxHeight: windowSize().height - (bottom ? safeArea().top : safeArea().bottom) - 24,
      paddingHorizontal: 16,
      // Above the keyboard while a field has it, above the home indicator otherwise.
      ...(bottom ? { paddingBottom: Math.max(safeArea().bottom, keyboardFrame().height) + 16 } : {}),
      gap: 14,
    };
  }
  const r = 16;
  return {
    ...surface,
    width: Math.min(360, windowSize().width - 48),
    paddingHorizontal: 20,
    paddingTop: safeArea().top + 16,
    paddingBottom: safeArea().bottom + 16,
    gap: 16,
    borderCurve: "continuous",
    ...(side === "right"
      ? { borderLeftWidth: 1, borderTopLeftRadius: r, borderBottomLeftRadius: r }
      : { borderRightWidth: 1, borderTopRightRadius: r, borderBottomRightRadius: r }),
  };
}

/** The grabber at the top of a bottom sheet (a view's `style`): a pill 36
 * by 5 points in the raised fill, centered. */
export function sheetGrabber(): ViewStyle {
  return { width: 36, height: 5, borderRadius: 3, alignSelf: "center", backgroundColor: colors.raised };
}

/**
 * A dialog shown as a card in the middle of the window, over `backdrop()`:
 * the card's surface with the border's edge and the floating shadow of a
 * menu (`finish.menu`), 16-point corners, 20 points of padding, its rows 12
 * apart. Given a `width`, it is `nsh/base`'s `Dialog`'s `style` itself:
 * centered, `width` across and never wider than 90% of the window; without
 * one, the look alone, for a view inside the dialog (one that springs in).
 * A terminal draws its edge alone.
 */
export function dialogCard(width?: number): ViewStyle {
  return {
    ...(width === undefined ? {} : { margin: "auto", width, maxWidth: "90%" }),
    borderRadius: 16,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 12,
    ...(terminal ? {} : { backgroundColor: colors.surface, boxShadow: finish.menu.boxShadow }),
  };
}

/** A card dialog's title (`dialogCard`): 17 points semibold with a pointer, 20 on a touch screen. */
export function dialogTitle(): TextStyle {
  return { fontSize: pointer ? 17 : 20, fontWeight: "600", color: colors.text };
}

/** A card dialog's text under its title: 13 points with a pointer, 15 on a touch screen, muted. */
export function dialogText(): TextStyle {
  return { fontSize: pointer ? 13 : 15, lineHeight: pointer ? 19 : 21, color: colors.muted };
}

/**
 * A toast (`nsh/base`'s `Toast`'s `style`): a row 12 points apart on the
 * raised fill and finish with the border's edge, 10-point corners
 * (`radius.inset`), 12 by 14 points of padding. Its title takes
 * `toastTitle`, its description `toastText`.
 */
export function toastLook(): ViewStyle {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.inset,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    ...finish.raised,
  };
}

/** A toast's title: 14 points semibold. */
export function toastTitle(): TextStyle {
  return { fontSize: 14, fontWeight: "600", color: colors.text };
}

/** A toast's description: 13 points, muted, its figures tabular. */
export function toastText(): TextStyle {
  return { fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] };
}

/** The size of a toast's action: 28 points tall with a pointer, 10 points
 * of padding at its sides; `small` on a touch screen (36, a hit slop
 * making 44), so the toast stays a compact row. */
const toastAction: ButtonLookOptions = pointer ? { style: { paddingHorizontal: 10 } } : { size: "small" };

/** A toast's action (an Undo, a Retry), spread on a `Button` or a pressable
 * view: the main action's citrus button (`buttonLook("primary")`). Its
 * label takes `toastActionLabel`. */
export function toastActionLook() {
  return buttonLook("primary", toastAction);
}

/** The label of a `toastActionLook` (`buttonLabel("primary")`). */
export function toastActionLabel(): TextStyle {
  return buttonLabel("primary", toastAction);
}

/** A toast's close button (its cross): a circle 24 points across, bare
 * until the pointer is over it, sinking to 90% while pressed (none with
 * reduced motion); keyboard focus `focusRing()`. */
export function toastCloseLook() {
  return {
    style: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
      ...pressTransition("background-color"),
    } as ViewStyle,
    get hoverStyle(): ViewStyle {
      return hovered();
    },
    get activeStyle(): ViewStyle {
      return { backgroundColor: alpha(colors.text, 0.1), ...pressSink(0.9).activeStyle };
    },
    get focusStyle(): ViewStyle {
      return focusRing();
    },
  };
}
