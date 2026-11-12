// What a menu looks like: its items, the rows that open and leave a
// submenu, a group's title, a separator, the popup surface its items come
// in on and the sheet a touch screen shows it in. Shared by the gallery's menus
// (the Menu demo, a toolbar's and a split button's menus, a pagination's
// jump menu) and by the website's demos (through `demo.ts`). `nsh/base`'s
// menus draw none of it.
import type { JSX, TextStyle, ViewStyle } from "nsh";
import { platform, Text, token, View } from "nsh";
import { Icon } from "../icons";
import { popInStyles, type PopupSide, popupSurface } from "../popup";
import { alpha, colors, finish, terminal } from "../theme";
import { backdrop } from "./overlay";

const pointer = platform.desktop;

/** A menu row's height, corners and type: compact with a pointer, a
 * finger's row on a touch screen. */
export interface MenuItemDimensions {
  height: number;
  radius: number;
  font: number;
  /** A note's size (a shortcut, a value). */
  note: number;
  /** A leading icon's or a check's size. */
  icon: number;
}

/** A menu row's height, corners and type: 26 points tall with a pointer, 46 on a touch screen. */
export const menuItemSize: MenuItemDimensions = pointer
  ? { height: 26, radius: 6, font: 13, note: 11.5, icon: 14 }
  : { height: 46, radius: 10, font: 16, note: 14, icon: 18 };

/** A row's inset from the popup's sides: in a terminal the popup's own padding is its Cell from the frame. */
const inset = terminal ? 0 : 8;

/** A row under the pointer or the keyboard (`hoverStyle`, `focusStyle`): a
 * flat neutral fill, the theme's `accent`. */
export const menuHighlight = (): ViewStyle => ({ backgroundColor: token("accent") });

/** A row pressed (`activeStyle`): a shade deeper than the highlight. */
export const menuPressed = (): ViewStyle => ({ backgroundColor: alpha(colors.text, 0.1) });

/** Options of `menuItemLook`. */
export interface MenuItemLookOptions {
  /** A row of two lines (a label and a note under it): as tall as they are,
   * 6 points above and below with a pointer, 10 on a touch screen, its mark
   * at the top. */
  tall?: boolean;
  /** More style (a justification, a padding), over the look's. */
  style?: ViewStyle;
}

/**
 * A menu row's props (spread them on `nsh/base`'s `MenuItem`, or on a
 * `Submenu`'s trigger): a row 8 points apart, 26 points tall with a
 * pointer and 46 on a touch screen (`menuItemSize`), 8 points in from the
 * popup's sides. Under the pointer and under the keyboard alike it takes
 * the neutral `accent` fill (`menuHighlight`), so arrow keys show where
 * they are; pressed, a shade deeper; disabled, 50%. Its label takes
 * `menuItemLabel`, a note `menuItemNote`, an icon `menuItemGlyph`.
 */
export function menuItemLook(o?: MenuItemLookOptions) {
  return {
    get style(): ViewStyle {
      return {
        flexDirection: "row",
        alignItems: o?.tall ? "flex-start" : "center",
        gap: 8,
        ...(o?.tall ? { paddingVertical: pointer ? 6 : 10 } : { height: menuItemSize.height }),
        paddingHorizontal: inset,
        borderRadius: menuItemSize.radius,
        borderCurve: "continuous",
        ...o?.style,
      };
    },
    get hoverStyle(): ViewStyle {
      return menuHighlight();
    },
    get focusStyle(): ViewStyle {
      return menuHighlight();
    },
    get activeStyle(): ViewStyle {
      return menuPressed();
    },
    disabledStyle: { opacity: 0.5 } as ViewStyle,
  };
}

/** Options of `menuItemLabel` and `menuItemGlyph`. */
export interface MenuItemTextOptions {
  /** A destructive item: the danger tone. */
  danger?: boolean;
}

/** A menu row's label: 13 points with a pointer, 16 on a touch screen, on one line, taking the row's free width. */
export function menuItemLabel(o?: MenuItemTextOptions): TextStyle {
  return { numberOfLines: 1, flexGrow: 1, flexShrink: 0, fontSize: menuItemSize.font, color: o?.danger ? colors.danger : colors.text };
}

/** A menu row's note at its trailing edge (a shortcut, a value): 11.5 points with a pointer, 14 on a touch screen, faint. */
export function menuItemNote(): TextStyle {
  return { fontSize: menuItemSize.note, color: colors.faint };
}

/** A menu row's leading icon (`<Icon {...menuItemGlyph()} />`): 14 points with a pointer, 18 on a touch screen, muted (the danger tone for a destructive item). */
export function menuItemGlyph(o?: MenuItemTextOptions) {
  return {
    size: menuItemSize.icon,
    get tint() {
      return o?.danger ? colors.danger : colors.muted;
    },
  };
}

/** Options of `menuPopup`. */
export interface MenuPopupOptions {
  /** The side of its trigger it opens on (its `placement`), which it comes in from: `"bottom"` unless set. */
  side?: PopupSide;
  /** With a pointer, its least width in points: 200 unless set. */
  minWidth?: number;
}

/**
 * What a menu takes besides its items (spread it on a `Menu` or a
 * `ContextMenu`; its submenus' popups take the same): with a pointer the
 * popup surface every menu shares (`popupSurface`), at least `minWidth`
 * across, coming in from the trigger's `side` (`popInStyles`: a fade, 96%
 * to full size, 4 points of slide, 150 ms); on a touch screen the sheet
 * that slides up, the card's surface with its top corners 20 points round
 * and 34 points under its rows for the home indicator; the scrim behind the
 * sheet. The surface is the popup's own box: `nsh/base` holds it to the
 * room on its side and scrolls the items inside it, so its edges and
 * shadow stay put. Its values are getters, so they follow the appearance.
 */
export function menuPopup(o?: MenuPopupOptions) {
  return {
    get popupStyle(): ViewStyle {
      return pointer
        ? { ...popupSurface(), minWidth: o?.minWidth ?? 200, ...popInStyles(o?.side).style }
        : { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderCurve: "continuous", paddingHorizontal: 10, paddingTop: 10, paddingBottom: 34 };
    },
    get popupStartingStyle(): ViewStyle | undefined {
      return pointer ? popInStyles(o?.side).starting : undefined;
    },
    get backdropStyle(): ViewStyle {
      return backdrop();
    },
  };
}

/** A group's title in a menu: not an item, nothing to press; 11 points semibold with a pointer, 13 on a touch screen, faint. */
export function MenuLabel(props: { text: string }) {
  return (
    <Text style={{ fontSize: pointer ? 11 : 13, fontWeight: "600", color: colors.faint, paddingHorizontal: inset, paddingTop: 6, paddingBottom: 2 }}>
      {props.text}
    </Text>
  );
}

/** A separator between a menu's groups (`<MenuSeparator style={menuSeparator()} />`): a groove, a hairline with a lip of light under it (`finish.groove`). */
export function menuSeparator(): ViewStyle {
  return { height: 1, marginTop: 4, marginBottom: 5, marginHorizontal: 4, backgroundColor: colors.line, boxShadow: finish.groove.boxShadow };
}

/**
 * The row that opens a submenu (a `Submenu`'s `trigger`): `menuItemLook`'s
 * row, `lead` (an icon) before the label and a faint chevron at its end;
 * disabled, 50%.
 */
export function SubmenuRow(props: { label: string; lead?: JSX.Element; disabled?: boolean }) {
  const look = menuItemLook();
  return (
    <View
      hoverStyle={props.disabled ? undefined : look.hoverStyle}
      focusStyle={look.focusStyle}
      activeStyle={props.disabled ? undefined : look.activeStyle}
      style={{ ...look.style, opacity: props.disabled ? 0.35 : 1 }}
    >
      {props.lead}
      <Text style={menuItemLabel()}>{props.label}</Text>
      <Icon name="chevron" size={pointer ? 12 : 14} tint={colors.faint} />
    </View>
  );
}

/** The row a touch screen's sheet shows above a submenu's items to go back (a `Submenu`'s `back`): a back chevron and the submenu's label in the accent. */
export function SubmenuBack(props: { label: string }) {
  const look = menuItemLook({ style: { gap: 6 } });
  return (
    <View activeStyle={look.activeStyle} style={look.style}>
      <Icon name="back" size={14} tint={colors.accent} />
      <Text style={{ fontSize: menuItemSize.font, fontWeight: "600", color: colors.accent }}>{props.label}</Text>
    </View>
  );
}
