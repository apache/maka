// What tab strips and segmented controls look like, shared by the gallery's
// `Segmented`, its Tabs demo and the website's demos (through `demo.ts`):
// a sunk track whose selected segment is a thumb standing off it, a pill
// strip, and an underlined strip whose line travels to the selected tab.
import type { TextStyle, ViewStyle } from "nsh";
import { platform, Text, View } from "nsh";
import { Icon, type IconName } from "../icons";
import { colors, finish, focusRing, follow, hovered, motion, radius, terminal } from "../theme";
import { controlSize } from "./surface";

const pointer = platform.desktop;

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

/** The state of one tab or segment, read where the look is applied. */
export interface TabState {
  selected: Live<boolean | undefined>;
  disabled?: Live<boolean | undefined>;
}

/** The props a tab's or segment's look gives it (a `Tab`, a `Radio`). */
export interface TabLook {
  readonly style: ViewStyle;
  readonly hoverStyle: ViewStyle | undefined;
  readonly activeStyle?: ViewStyle;
  readonly focusStyle: ViewStyle;
  readonly disabledStyle: ViewStyle;
}

/** Under the pointer, a tab that is neither selected (its thumb shows) nor disabled. */
const hoverOf = (state: TabState) => (read(state.selected) || read(state.disabled) ? undefined : hovered());

/** A segmented control's size: 26 / 30 points with a pointer, 32 / 36 on a touch screen. */
export type SegmentedSize = "small" | "regular";

/** Options of `segmentedLook`. */
export interface SegmentedLookOptions {
  /** Default `regular`. */
  size?: SegmentedSize;
  /** Span the row, the segments sharing it equally (always on a touch screen). */
  fill?: boolean;
}

/**
 * A segmented control's look: a sunk track (`style`, on `Tabs` or a
 * `RadioGroup`) as wide as its labels with a pointer (30 points high,
 * 12-point labels, the thumb's corners 6 and the track's 9), spanning the
 * row on a touch screen or with `fill`; the selected segment's thumb,
 * standing off the track in both appearances (`finish.thumb`: white with a
 * soft drop on a light track), as `Tabs`' traveling `indicatorStyle` or as
 * a `Radio`'s `checkedStyle` (`thumbStyle`); each segment's props
 * (`segment(state)`: hover, the focus ring, dimmed while disabled) and its
 * label's (`label(selected)`, `count`).
 */
export function segmentedLook(o?: SegmentedLookOptions) {
  const small = o?.size === "small";
  const spread = !pointer || !!o?.fill;
  // The track's padding: the thumb sits inside it.
  const inset = 2;
  const height = pointer ? (small ? 26 : 30) : small ? 32 : 36;
  const corner = pointer ? 6 : 7;
  const thumb = (): ViewStyle => ({ borderRadius: corner, borderCurve: "continuous", borderWidth: 1, ...finish.thumb });
  return {
    get style(): ViewStyle {
      return {
        height,
        flexDirection: "row",
        alignSelf: spread ? "stretch" : "flex-start",
        padding: inset,
        borderRadius: pointer ? 9 : 10,
        borderCurve: "continuous",
        backgroundColor: colors.track,
        boxShadow: finish.track.boxShadow,
        borderWidth: 1,
        borderColor: finish.track.borderColor,
      };
    },
    /** The thumb as `Tabs`' indicator, which the core springs to the selected tab. */
    get indicatorStyle(): ViewStyle {
      return { top: inset, bottom: inset, ...thumb() };
    },
    /** The thumb on the selected segment itself (a `Radio`'s `checkedStyle`). */
    get thumbStyle(): ViewStyle {
      return thumb();
    },
    segment(state: TabState): TabLook {
      return {
        // A clear edge the thumb's takes over, so a checked segment keeps its size.
        style: {
          ...(spread ? { flex: 1, paddingHorizontal: 7 } : { paddingHorizontal: 9 }),
          borderRadius: corner,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: "transparent",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
        },
        get hoverStyle() {
          return hoverOf(state);
        },
        get focusStyle() {
          return focusRing();
        },
        disabledStyle: { opacity: 0.4 },
      };
    },
    label(selected: Live<boolean | undefined>): TextStyle {
      return {
        numberOfLines: 1,
        fontSize: pointer ? 12 : small ? 13 : 14,
        fontWeight: "500",
        color: read(selected) ? colors.text : colors.muted,
      };
    },
    get count(): TextStyle {
      return { fontSize: pointer ? 11 : 12, color: colors.faint, fontVariant: ["tabular-nums"] };
    },
  };
}

/**
 * A tab strip's look, the gallery's section switcher: a capsule track
 * `controlSize.tabs` high (30 with a pointer, 40 on a touch screen), sunk
 * into the surface with a hairline edge, the tabs sharing its width; the
 * selected tab's pill (`indicatorStyle`, `finish.thumb`) springs to the next
 * one natively. `tab(state)`: a tab's props (hover on the others, the focus
 * ring, dimmed while disabled). Pair each tab with a `TabTitle`.
 */
export function tabsLook() {
  // The track's padding and border: a tab is a pill inside them.
  const inset = 3;
  const inner = controlSize.tabs - 2 * (inset + 1);
  return {
    get style(): ViewStyle {
      return {
        height: controlSize.tabs,
        flexDirection: "row",
        gap: 2,
        padding: inset,
        borderRadius: controlSize.tabs / 2,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.inset,
        boxShadow: finish.track.boxShadow,
      };
    },
    get indicatorStyle(): ViewStyle {
      return { top: inset, bottom: inset, borderRadius: inner / 2, borderWidth: 1, ...finish.thumb };
    },
    tab(state: TabState): TabLook {
      return {
        style: { flex: 1, paddingHorizontal: 6, borderRadius: inner / 2, borderWidth: 1, borderColor: "transparent", alignItems: "center", justifyContent: "center" },
        get hoverStyle() {
          return hoverOf(state);
        },
        get focusStyle() {
          return focusRing();
        },
        disabledStyle: { opacity: 0.4 },
      };
    },
  };
}

/**
 * An underlined tab strip's look: tabs as wide as their labels
 * (`controlSize.tabs` high), a 2-point accent line (`indicatorStyle`) at the
 * strip's bottom that travels and stretches to the selected tab, over a
 * hairline (`rule`, a view under the strip: outside a scroll view holding
 * it, so its clipping never cuts the line). `tab(state)`: a tab's props
 * (hover on the others, a press that dims, the focus ring, dimmed while
 * disabled).
 */
export function underlineTabsLook() {
  return {
    get style(): ViewStyle {
      return { flexDirection: "row", gap: 2, paddingTop: 3 };
    },
    get indicatorStyle(): ViewStyle {
      return { bottom: 0, height: 2, borderRadius: 1, backgroundColor: colors.accent };
    },
    get rule(): ViewStyle {
      return { pointerEvents: "none", position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: colors.line };
    },
    tab(state: TabState): TabLook {
      return {
        get style(): ViewStyle {
          return { height: controlSize.tabs, paddingHorizontal: 8, marginBottom: 4, borderRadius: radius.control, borderWidth: 1, borderColor: "transparent", justifyContent: "center" };
        },
        get hoverStyle() {
          return hoverOf(state);
        },
        activeStyle: { opacity: 0.7 },
        get focusStyle() {
          return focusRing();
        },
        disabledStyle: { opacity: 0.4 },
      };
    },
  };
}

/** The room a tab title's icon takes: the icon and the gap after it. */
export const TAB_ICON_ROOM = 14 + 6;

/**
 * A tab's label (and icon, and a count in a capsule): the text color while
 * selected, fading in as the indicator arrives (`motion.move`), the icon's
 * two tints crossing over. It keeps its natural width (never truncated) and
 * reports it without the icon (`onWidth`): the same whether the icon shows
 * or not, so a row deciding on its icons by it never flips back.
 * `underline`: a terminal marks the selected tab of an underlined strip by
 * underlining its label, where the strip's indicator, thinner than a Cell,
 * does not show.
 */
export function TabTitle(props: { name: string; selected: boolean; count?: number; icon?: IconName; underline?: boolean; onWidth?: (bare: number) => void }) {
  const on = follow(() => (props.selected ? 1 : 0), motion.move);
  const away = on.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  return (
    <View
      onLayout={({ bounds }) => props.onWidth?.(bounds.size.width - (props.icon ? TAB_ICON_ROOM : 0))}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}
    >
      <If when={props.icon}>
        <View style={{ width: 14, height: 14 }}>
          <View style={{ position: "absolute", opacity: away }}>
            <Icon name={props.icon!} size={14} tint={colors.muted} />
          </View>
          <View style={{ position: "absolute", opacity: on }}>
            <Icon name={props.icon!} size={14} tint={colors.text} />
          </View>
        </View>
      </If>
      <Text
        style={{
          numberOfLines: 1,
          fontSize: 13,
          fontWeight: "500",
          color: on.interpolate({ inputRange: [0, 1], outputRange: [colors.muted, colors.text] }),
          textDecorationLine: terminal && props.underline && props.selected ? "underline" : "none",
        }}
      >
        {props.name}
      </Text>
      <If when={props.count !== undefined}>
        <View style={{ minWidth: 18, height: 16, paddingHorizontal: 5, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}>
          <Text style={{ fontSize: 10, fontWeight: "600", color: colors.muted, fontVariant: ["tabular-nums"] }}>{props.count}</Text>
        </View>
      </If>
    </View>
  );
}
