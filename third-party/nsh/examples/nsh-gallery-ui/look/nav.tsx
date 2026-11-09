// What the navigation controls look like, shared by the gallery's Carousel,
// Link and Pagination demos and by the website's demos (through `demo.ts`):
// a carousel's arrows and dots, a link's text with its underline, a
// pagination's items. Scroll bars take the gallery's `scrollbarTheme`
// (`scrollbar-theme.ts`).
import type { JSX, ViewStyle } from "nsh";
import type { PaginationItemState } from "nsh/base";
import { platform, Text, token, View } from "nsh";
import { Icon } from "../icons";
import { alpha, colors, finish, focusRing, terminal } from "../theme";
import { pressSink, pressTransition } from "./press";

const pointer = platform.desktop;

// Carousel ---------------------------------------------------------------

/** A carousel's controls: an arrow's side and its icon, a pagination dot
 * and the touch-sized item around it. Compact with a pointer, roomier on a
 * touch screen. */
export const carouselSizes = pointer ? { arrow: 30, arrowIcon: 16, dot: 7, hit: 15 } : { arrow: 38, arrowIcon: 18, dot: 8, hit: 22 };

/** The properties a carousel control's states change, eased as a press. */
const fade: ViewStyle = pressTransition("background-color, border-color, opacity");

/** Options of `carouselArrowLook`. */
export interface CarouselArrowOptions {
  /** Over a photo: glass (`finish.glass`), so the photo shows through. */
  glass?: boolean;
  /** Its side, default `carouselSizes.arrow`. */
  side?: number;
}

/**
 * A carousel's arrow (spread it on `CarouselPrevious` / `CarouselNext`, or a
 * round control beside them): a circle, raised on a card or glass over a
 * photo, with an icon in the text color (`carouselSizes.arrowIcon`). Under
 * the pointer it takes the hover fill; pressed it sinks to 92% (none with
 * reduced motion); keyboard focus: `focusRing(2)`; with nothing to move to
 * it fades to 30%. A terminal sizes it to its glyph.
 */
export function carouselArrowLook(o?: CarouselArrowOptions) {
  return {
    get style(): ViewStyle {
      if (terminal) return { alignItems: "center", justifyContent: "center", flexShrink: 0, ...fade };
      const side = o?.side ?? carouselSizes.arrow;
      return {
        width: side,
        height: side,
        borderRadius: side / 2,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        ...(o?.glass ? finish.glass : finish.raised),
        ...fade,
      };
    },
    get hoverStyle(): ViewStyle {
      return { ...finish.hover };
    },
    get activeStyle(): ViewStyle {
      return pressSink(0.92).activeStyle;
    },
    get focusStyle(): ViewStyle {
      return focusRing(2);
    },
    disabledStyle: { opacity: 0.3 } as ViewStyle,
  };
}

/**
 * A `CarouselPagination`'s look (spread it): its items in a row, and the
 * indicator, a citrus pill a dot high and two wide that springs to the item
 * of the slide shown, over its dot (`CarouselDot`). Hidden in a terminal,
 * whose dots are glyphs.
 */
export function carouselPaginationLook() {
  return {
    style: { flexDirection: "row", alignItems: "center", gap: terminal ? 8 : undefined } as ViewStyle,
    get indicatorStyle(): ViewStyle {
      if (terminal) return { display: "none" };
      const inset = (carouselSizes.hit - carouselSizes.dot) / 2;
      return { top: inset, bottom: inset, marginHorizontal: 1, borderRadius: carouselSizes.dot / 2, backgroundColor: colors.accentFill };
    },
  };
}

/** A `CarouselPaginationItem`'s look (spread it): a touch-sized item around
 * its dot, the `group` its dot follows, the keyboard's focus ring. */
export function carouselDotItemLook() {
  return {
    class: "group",
    style: (terminal ? {} : { width: carouselSizes.hit + 4, height: carouselSizes.hit, alignItems: "center", justifyContent: "center", borderRadius: carouselSizes.hit / 2 }) as ViewStyle,
    get focusStyle(): ViewStyle {
      return focusRing();
    },
  };
}

/** The dot of a pagination item: a quiet circle that brightens under the
 * pointer and hides under the pill on the slide shown; a glyph, filled on
 * the slide shown, in a terminal. */
export function CarouselDot(props: { selected: boolean }) {
  return terminal ? (
    <Text style={{ color: props.selected ? colors.accent : colors.muted }}>{props.selected ? "●" : "○"}</Text>
  ) : (
    <View
      class="opacity-70 group-hover:opacity-100 group-selected:opacity-0"
      style={{ width: carouselSizes.dot, height: carouselSizes.dot, borderRadius: carouselSizes.dot / 2, backgroundColor: alpha(colors.text, 0.24), ...fade }}
    />
  );
}

// Link -------------------------------------------------------------------

/** A link's text size: the body's, 13 points with a pointer, 15 on a touch screen. */
export const linkSize = pointer ? 13 : 15;

/** The color fades and the underline's bar slides; both stand still with reduced motion. */
const tint = "transition-colors duration-200 motion-reduce:transition-none";
const slide = "transition-transform duration-300 ease-out motion-reduce:transition-none";

/** What a link is, for its color (`linkColor`). */
export interface LinkState {
  disabled?: boolean;
  /** The page it names is the one shown. */
  current?: boolean;
  /** The app has opened it before. */
  visited?: boolean;
  /** A quiet link (a footer's): the muted text color, no static underline. */
  quiet?: boolean;
}

/** A link's color: the accent; violet once visited; the text color for the
 * current page; muted when quiet; faint while disabled. */
export function linkColor(o?: LinkState): string {
  return o?.disabled ? colors.faint : o?.current ? colors.text : o?.visited ? token("violet") : o?.quiet ? colors.muted : colors.accent;
}

/** A `Link`'s own look (spread it): a row of its text and icon, the
 * `group` they follow, dimmed while pressed, the keyboard's focus ring
 * around it; `inline` on a paragraph's baseline, else as wide as its text. */
export function linkLook(o?: { inline?: boolean }) {
  return {
    class: `group flex-row items-center gap-1 rounded-sm active:opacity-60 ${tint} ${o?.inline ? "align-text-bottom" : "self-start"}`,
    get focusStyle(): ViewStyle {
      return focusRing(2);
    },
  };
}

/**
 * A link's text (the child of a `Link` in `linkLook`): `label` in `color`
 * (`linkColor`), medium weight, semibold on the current page; a faint
 * hairline under it (none when quiet or disabled) and a 1.5-point bar of
 * its color over that, growing from the left under the pointer and always
 * there on the current page; `icon` an arrow to a site outside the app,
 * which nudges out of its box under the pointer.
 */
export function LinkText(props: LinkState & { label: string; color: string; size?: number; icon?: boolean }) {
  const size = () => props.size ?? linkSize;
  return (
    <>
      <View>
        <Text class={tint} style={{ fontSize: size(), fontWeight: props.current ? "600" : "500", color: props.color }}>
          {props.label}
        </Text>
        <If when={!props.quiet && !props.disabled}>
          <View class={`absolute left-0 right-0 bottom-0 h-px ${tint}`} style={{ backgroundColor: alpha(props.color, 0.35) }} />
        </If>
        <If when={!props.disabled}>
          <View
            class={`absolute left-0 right-0 bottom-0 h-[1.5px] origin-left rounded-full ${slide} ${props.current ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"}`}
            style={{ backgroundColor: props.color }}
          />
        </If>
      </View>
      <If when={props.icon}>
        <View class={`${slide} group-hover:translate-x-0.5 group-hover:-translate-y-0.5`}>
          <Icon name="external" size={Math.round(size() * 0.85)} tint={props.color} />
        </View>
      </If>
    </>
  );
}

// Pagination -------------------------------------------------------------

/** What every pagination item shares: quiet until hovered, the current page
 * lit as a primary button is, citrus under its dark text (`selected:`), with
 * a color fade (still with reduced motion), the ends dimmed (`disabled:`),
 * the focus ring's outline. */
const pageItem =
  "flex-row items-center justify-center gap-1 px-2 rounded-md text-sm text-foreground " +
  "transition-colors duration-200 motion-reduce:transition-none hover:bg-hover active:opacity-70 " +
  "selected:bg-primary selected:text-primary-foreground disabled:opacity-35 focus:outline-2 focus:outline-ring";

/**
 * A `Pagination`'s `itemClass`, over the component's own numbers and
 * labels: 32 points with a pointer, 44 on a touch screen; `outlined` (a
 * compact pager's Previous and Next, or every item on a touch screen) on the
 * border's edge, padded wider, 40 points tall with a pointer.
 */
export function paginationItemClass(o?: { outlined?: boolean }): string {
  const box = pointer ? (o?.outlined ? "min-w-8 h-10" : "min-w-8 h-8") : "min-w-11 h-11";
  return `${box} ${pageItem}${o?.outlined ? " px-3 border border-border" : ""}`;
}

/**
 * A `Pagination`'s items (its `renderItem`), as gpui-component's: Previous
 * and Next as chevrons (their accessibility labels name them), so a row of
 * pages fits a phone's width; a page its number, tabular; an ellipsis `…`.
 * A terminal's chevrons are glyphs.
 */
export function paginationArrows(item: PaginationItemState): JSX.Element {
  if (item.kind === "page") return <Text style={{ fontVariant: ["tabular-nums"] }}>{String(item.page)}</Text>;
  if (item.kind === "ellipsis") return <Text>…</Text>;
  if (terminal) return <Text style={{ color: colors.muted }}>{item.kind === "previous" ? "‹" : "›"}</Text>;
  return (
    <View style={item.kind === "previous" ? { transform: [{ rotate: "180deg" }] } : undefined}>
      <Icon name="chevron" size={pointer ? 14 : 16} tint={colors.text} />
    </View>
  );
}
