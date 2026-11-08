// What a plot looks like, shared by the gallery's Charts and by the
// website's plot demos (through `demo.ts`): the series' colors, the grid,
// the cross line and the hover's dot, the axes' text and the tooltip's
// card. Each is a function, so it reads the theme where it is drawn and
// follows the appearance.
import type { TextStyle, ViewStyle } from "nsh";
import { token } from "nsh";
import { alpha, chart, colors, finish, mono } from "../theme";

/** The series' colors, in order (`theme.json`'s `chart-1` to `chart-5`):
 * the brand's citrus first, then graphite from dark to light, so one series
 * leads and the rest stay as quiet as the interface. Rises and falls take
 * `colors.up` / `colors.down`. */
export const seriesColors = (): string[] => [chart.s1, chart.s2, chart.s3, chart.s4, chart.s5];

/** The `i`th series' color, around the five. */
export const seriesColor = (i: number): string => seriesColors()[i % 5];

/** Colors for categories that must read apart at a glance (sectors,
 * regions, platforms), in order: the citrus lead, then the theme's info,
 * warn and violet, and a graphite. */
export const categoryColors = (): string[] => [chart.s1, colors.info, colors.warn, token("violet"), chart.s3];

/** A grid's hairlines (`<Grid style={plotGrid()}>`): the theme's line. */
export const plotGrid = () => ({ stroke: colors.line });

/** A baseline, the grid's zero or its foot: firmer than the grid, the border's color. */
export const plotBaseline = () => ({ stroke: colors.border });

/** A reference (an open, a target): a dashed line of `color` (default the
 * text's) at 28%, quieter than the marks. */
export const plotReference = (color?: string) => ({ stroke: alpha(color ?? colors.text, 0.28), strokeDasharray: "2 4" });

/**
 * The cross line under the pointer (spread it on the `Plot`): a hairline of
 * the text color at 22% over a line or an area; `band`, a faint band (5%)
 * the width of a bar's band, over bars.
 */
export function plotCrossLine(o?: { band?: boolean }) {
  return {
    crossLineClass: o?.band ? "w-full h-full" : "w-px h-full",
    get crossLineStyle(): ViewStyle {
      return { backgroundColor: alpha(colors.text, o?.band ? 0.05 : 0.22) };
    },
  };
}

/** The hover's dot (a `Plot`'s `dotClass`): 10 points, ringed. */
export const plotDotClass = "size-2.5 rounded-full border-2";

/** The hover's dot on a line (`hoverDotStyle`): its series' color, ringed in
 * the inset's, so it cuts out of the line. */
export const plotHoverDot = (color: string): ViewStyle => ({ backgroundColor: color, borderColor: colors.inset });

/** A wash under a line (an `Area`'s `backgroundStyle`): `color` at `top`
 * opacity (default 18%) fading out to the baseline. */
export const plotWash = (color: string, top = 0.18): ViewStyle => ({
  backgroundImage: `linear-gradient(to bottom, ${alpha(color, top)}, ${alpha(color, 0)})`,
});

/** The values on the axes (a `PlotAxis`'s `labelStyle`): small, monospaced,
 * tabular and faint, so the marks lead. */
export const plotAxisText = (): TextStyle => ({ fontSize: 10.5, fontFamily: mono, color: colors.faint, fontVariant: ["tabular-nums"] });

/** A floating tooltip's card: the menu's surface, 10-point corners. */
export const plotTooltip = (): ViewStyle => ({ ...finish.menu, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 6 });

/** A tooltip's title over its values: a small, monospaced, muted label. */
export const plotTooltipTitle = (): TextStyle => ({ fontSize: 10, fontFamily: mono, letterSpacing: 0.8, color: colors.muted });
