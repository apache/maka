import type { JSX as __JSX } from "nsh";
import { Text as __Text, View as __View } from "nsh";
import { platform as __platform, windowSize as __windowSize } from "nsh";
import { Segmented as GallerySegmented } from "./segmented";
import { ui, tint } from "./palette";
import { radius } from "./theme";
import { insetSurface } from "./look/surface";
import { inputLook, type FieldLookOptions } from "./look/field";
import { buttonLabel, buttonLook, type ButtonKind, type ButtonLookOptions } from "./look/button";
export { ui, tint } from "./palette";
export { buttonGlyph, buttonLabel, buttonLook, buttonSizes, iconButtonGlyph, iconButtonLook, type ButtonKind, type ButtonLookOptions, type ButtonSize, type IconButtonLookOptions } from "./look/button";
export { switchHitSlop, switchLook, type SwitchLook, type SwitchSize } from "./look/switch";
export { toggleGlyph, toggleLabel, toggleLook, toggleSizes, toolbarRule, toolbarTrack, type ToggleDimensions, type ToggleLookOptions, type ToggleSize, type ToolbarTrackOptions } from "./look/tool";
export { menuHighlight, menuItemGlyph, menuItemLabel, menuItemLook, menuItemNote, menuItemSize, menuPressed, menuSeparator, menuSheet, MenuLabel, MenuPanel, SubmenuBack, SubmenuRow, type MenuItemDimensions, type MenuItemLookOptions, type MenuItemTextOptions } from "./look/menu";
export { backdrop, dialogCard, dialogText, dialogTitle, popoverLook, sheetGrabber, sheetPanel, toastActionLabel, toastActionLook, toastCloseLook, toastLook, toastText, toastTitle, tooltipLook, tooltipNote, tooltipText, type PopoverLookOptions, type SheetSide, type TooltipLookOptions } from "./look/overlay";
export { pressSink } from "./look/press";
export { controlSize, density, insetSurface, listRow, plainRow, RowDivider, RowLabel, sectionSurface, type ListRowLook, type ListRowOptions, type PlainRowOptions, type SectionSurfaceOptions } from "./look/surface";
export { CheckboxMark, checkboxLook, choiceTileLook, MARK_WEIGHT, RadioRing, type CheckboxLook, type CheckboxMarkKind, type ChoiceOptions, type ChoiceTileLook, type ChoiceTileOptions } from "./look/choice";
export { segmentedLook, TabTitle, tabsLook, underlineTabsLook, type SegmentedLookOptions, type SegmentedSize, type TabLook, type TabState } from "./look/tabs";
export { fieldLook, fieldSize, fieldText, inputLook, numberInputClasses, numberInputSteps, numberInputText, NumberStep, otpCellLook, otpCells, timeFieldClass, type FieldLookOptions, type FieldTextOptions, type OtpCellOptions } from "./look/field";
export { calendarLook, CalendarItem, Chevron, clearButtonLook, ComboToggle, comboboxLook, datePickerLook, ListboxEmpty, listboxFooter, ListboxHeader, listboxPopup, listboxProps, listboxSearch, OptionRow, optionClass, Picker, pickerLook, TimeSegment, type ClearButtonOptions, type ComboboxLookOptions, type DatePickerLookOptions, type ListboxPopupOptions, type PickerLookOptions } from "./look/listbox";
export { progressFill, progressGlide, progressLook, progressRail, progressRemaining, progressSweep, type ProgressLookOptions, type ProgressSweep } from "./look/meter";
export { DisclosureChevron, disclosurePanel, disclosureTriggerLook, type DisclosurePanelOptions, type DisclosureTriggerOptions } from "./look/disclosure";
export { carouselArrowLook, CarouselDot, carouselDotItemLook, carouselPaginationLook, carouselSizes, linkColor, linkLook, linkSize, LinkText, paginationArrows, paginationItemClass, type CarouselArrowOptions, type LinkState } from "./look/nav";
export { categoryColors, plotAxisText, plotBaseline, plotCrossLine, plotDotClass, plotGrid, plotHoverDot, plotReference, plotTooltip, plotTooltipTitle, plotWash, seriesColor, seriesColors } from "./look/plot";
export { DiffHunkActions, dockClasses, DockDragPreview, DockTab, dockTabCloseClass, resizableHandle, resizableHandleLook, richEditorClasses, textViewCaretClass, textViewLinkClasses } from "./look/workspace";
export { photoUrl, type PhotoName } from "./photos";
export { scrollbarTheme } from "./scrollbar-theme";

/** A pressable under the pointer (`hoverStyle`): a whisper of the text
 * color over its surface, quieter than pressed and than selected. Leave it
 * off a disabled control. */
export const hoverFill = () => ({ backgroundColor: tint(ui().text, 0.05) });

/** The keyboard focus (`focusStyle`), one for every control: the edge
 * turns the theme's `ring` and a 3-point halo of it lies around the view,
 * outside its edge (`focusRing(offset)` moves the halo further out). */
export { focusRing } from "./theme";

/** A pointer and a keyboard: desktop density and copy ("Click", "Tab to it
 * and press Space"); touch density and copy ("Tap") otherwise. */
export const desktop = __platform.desktop;

/** A window wide enough for the desktop layout (the site's Desktop frame is
 * the documentation column's width, about 720 points). */
export const wide = () => __windowSize().width >= 700;

/** Wide enough to put a `Split`'s inspector beside its stage rather than
 * under it: in the site's Desktop frame the subject keeps the whole width. */
const sideBySide = () => __windowSize().width >= 900;

/** Heights and type of the idiom (Design Guides, "Density tiers"): compact
 * with a pointer, 44-point targets on a touch screen. */
export const size = desktop
  ? { control: 32, controlSm: 28, row: 40, rowSm: 32, label: 14, detail: 12 }
  : { control: 44, controlSm: 44, row: 52, rowSm: 44, label: 15, detail: 12 };

/** Options of `button` and `buttonText` (the same object for both). */
export interface ButtonOptions {
  /** `sm`: the compact size (`buttonLook`'s `small`: 24 points with a
   * pointer, 36 on a touch screen). */
  size?: "md" | "sm";
  /** Shown as chosen (`buttonLook`'s `selected`): the trigger of what is
   * open, or the current one of a few. Something on or off is a `Toggle`
   * in `toggleLook`, not a button. */
  on?: boolean | (() => boolean);
  /** Disabled (pass the same value to the element's `disabled`): no hover
   * and no press feedback; dimmed to 40%. */
  disabled?: boolean | (() => boolean);
  /** Where it sits in a column of a desktop layout (`alignSelf`): buttons
   * are as wide as their labels there, so the default is `flex-start`;
   * `stretch` fills the column. On a touch screen it fills the column. */
  align?: "flex-start" | "center" | "flex-end" | "stretch";
  /** More style (a margin, a width, a flex), over the button's. */
  style?: object | (() => object);
}

const __read = <T,>(v: T | (() => T)): T => (typeof v === "function" ? (v as () => T)() : v);

/** `buttonLook`'s options for a demo's `ButtonOptions`. */
function __look(o?: ButtonOptions): ButtonLookOptions {
  return {
    size: o?.size === "sm" ? "small" : "regular",
    selected: () => !!__read<boolean | undefined>(o?.on),
    disabled: () => !!__read<boolean | undefined>(o?.disabled),
    style: () => ({
      ...(desktop ? { alignSelf: o?.align ?? ("flex-start" as const) } : o?.align ? { alignSelf: o.align } : {}),
      ...(__read<object | undefined>(o?.style) ?? {}),
    }),
  };
}

/** A button's props (spread them: `<Button {...button("primary")}>`):
 * `buttonLook`'s, the gallery's buttons' look, with the demos' column
 * alignment. Pair it with `buttonText` for the label. */
export function button(kind: ButtonKind = "secondary", o?: ButtonOptions) {
  return buttonLook(kind, __look(o));
}

/** The label of a `button` of the same kind and options (`buttonLabel`). */
export function buttonText(kind: ButtonKind = "secondary", o?: ButtonOptions) {
  return buttonLabel(kind, __look(o));
}

/** Options of `field`: `inputLook`'s (`invalid`, `readonly`, `disabled`, `multiline`, `style`). */
export type FieldOptions = FieldLookOptions;

/** A lone text field's props (spread them: `<Input {...field()} />`), the
 * gallery's field (`inputLook`): a recessed well, 28 points high with text
 * 13 under a pointer, 46 with text 15 on a touch screen; a stronger edge
 * under the pointer, the 2-point accent focus edge, the danger tone while
 * invalid, 50% while disabled. */
export const field = inputLook;

/** The subject in a wide window: a quiet bordered stage (the theme's card
 * corners, a whisper of the text color) that takes the room and centers its
 * content, at most `width` across (440). */
export function Stage(props: { children?: __JSX.Element; width?: number; gap?: number }) {
  return __View({
    get style() {
      return {
        flex: 1,
        minWidth: 0,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: ui().line,
        backgroundColor: tint(ui().text, 0.02),
        padding: 24,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      };
    },
    get children() {
      return __View({
        get style() {
          return { width: "100%" as const, maxWidth: props.width ?? 440, gap: props.gap ?? 14 };
        },
        get children() {
          return props.children;
        },
      });
    },
  });
}

/** The column beside a stage: the subject's state, its event log and the
 * options that tune it. */
export function Inspector(props: { children?: __JSX.Element }) {
  return __View({
    style: { width: 300, gap: 12 },
    get children() {
      return props.children;
    },
  });
}

/** The subject and its inspector: a stage beside an inspector column in a
 * wide window, one column `gap` apart otherwise (`grow`: the column fills
 * the page's height). A window crossing the width changes only the styles:
 * the subject and the inspector stay the same views, so they keep their
 * state (a component's own, and what the app heard from it). */
export function Split(props: { children?: __JSX.Element; inspector?: __JSX.Element; gap?: number; width?: number; grow?: boolean }) {
  const gap = () => props.gap ?? 14;
  // Stacked, the subject keeps its own height and the inspector takes what
  // is left of a growing column, as when they were the column's own items.
  const narrow = () => ({ gap: gap() });
  return __View({
    get style() {
      return sideBySide() ? { flex: 1, flexDirection: "row" as const, gap: 16 } : { flex: props.grow ? 1 : undefined, gap: gap() };
    },
    get children() {
      return [
        // The stage: a bordered frame centering the subject, side by side.
        __View({
          get style() {
            return sideBySide()
              ? {
                  flex: 1,
                  minWidth: 0,
                  borderRadius: radius.card,
                  borderWidth: 1,
                  borderColor: ui().line,
                  backgroundColor: tint(ui().text, 0.02),
                  padding: 24,
                  alignItems: "center" as const,
                  justifyContent: "center" as const,
                }
              : narrow();
          },
          get children() {
            return __View({
              get style() {
                return sideBySide() ? { width: "100%" as const, maxWidth: props.width ?? 440, gap: gap() } : narrow();
              },
              get children() {
                return props.children;
              },
            });
          },
        }),
        // The inspector: a column beside the stage, under it otherwise.
        __View({
          get style() {
            return sideBySide() ? { width: 300, gap: 12 } : { flex: props.grow ? 1 : undefined, gap: gap() };
          },
          get children() {
            return props.inspector;
          },
        }),
      ];
    },
  });
}

/** A recessed panel of state under a small title, a well
 * (`insetSurface`) in the page (`grow`: it takes the column's free height). */
export function Panel(props: { title: string; children?: __JSX.Element; minHeight?: number; grow?: boolean }) {
  const title = __Text({
    get style() {
      return { fontSize: 12, color: ui().muted };
    },
    get children() {
      return props.title;
    },
  });
  return __View({
    get style() {
      return { ...insetSurface(), padding: 12, gap: 4, minHeight: props.minHeight, flex: props.grow ? 1 : undefined };
    },
    get children() {
      return [title, props.children];
    },
  });
}

/** An event log, newest first: the newest line in the text color, older
 * ones faint. Beside a stage it takes the inspector's free height. */
export function Log(props: { title: string; lines: string[]; minHeight?: number; grow?: boolean }) {
  return Panel({
    get title() {
      return props.title;
    },
    get minHeight() {
      return props.minHeight;
    },
    get grow() {
      return props.grow ?? sideBySide();
    },
    get children() {
      return props.lines.map((line, i) =>
        __Text({
          get style() {
            return { fontSize: 12, color: i === 0 ? ui().text : ui().faint };
          },
          children: line,
        }),
      );
    },
  });
}

/** A labelled demo option row using the shared segmented control. */
export function Segmented<T extends string | number>(props: { label?: string; options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return __View({
    style: { gap: 6 },
    get children() {
      return [
        props.label ? __Text({ style: { fontSize: 12, color: ui().muted }, children: props.label }) : null,
        GallerySegmented({
          get options() { return props.options.map((value) => ({ value: String(value), label: String(value) })); },
          get value() { return String(props.value); },
          onChange: (value) => props.onChange(props.options.find((option) => String(option) === value)!),
          size: desktop ? "small" : "regular",
        }),
      ];
    },
  });
}

export { dataTableClasses, dataTableFitPadding } from "./data-table";
export { sliderFill, sliderLook, sliderValueClass, sliderValueStyle, type SliderLookOptions } from "./slider";
export { avatarHue, avatarIdentity, avatarPortrait, AVATAR_BROKEN } from "./avatar";
