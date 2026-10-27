import type { TextStyle, ViewStyle } from "nsh";
import { platform } from "nsh";
import { alpha, colors } from "./theme";

/** Options of `sliderLook`. */
export interface SliderLookOptions {
  /** A vertical slider: the rail 8 wide, the thumb 8 × 16. */
  vertical?: boolean;
  /** The value column after the track (`children`: a 42-point label). */
  value?: boolean;
}

/** The value column's label (`<Text class={sliderValueClass}
 * style={sliderValueStyle()}>`): 42 points, right aligned, monospaced, its
 * line as tall as its type so it centers on the rail. */
export const sliderValueClass = "w-[42px] text-right font-mono text-[11px] leading-none";

/** The value column label's color: the soft text color (60% of the
 * text's). */
export const sliderValueStyle = (): TextStyle => ({ color: alpha(colors.text, 0.6) });

/**
 * A `Slider`'s parts (spread them: `<Slider {...sliderLook()}>`), after BJORK
 * UI's slider: an 8-point rail in the track's tone with a faint glow of the
 * accent, the thumb a 16 × 8 pill as tall as the rail, sitting in it. Under
 * the pointer the pill brightens, more while dragged, and neither while
 * disabled; the keyboard's focus rings the rail; a disabled slider fades to
 * 35% (transitions still with reduced motion). With a pointer the rail is the
 * track, the thumbs travel inside it; on a touch screen the track is a
 * 32-point band around the rail, so a finger finds it.
 *
 * Only what never changes is here, so the spread reads no signal: a spread
 * is evaluated where the slider is made, and a signal read there would make
 * the slider again when it changes (in the middle of a drag). The colors are
 * getters, read by the slider's props as the appearance changes; the fill
 * (`rangeStyle={sliderFill(..)}`) and `disabled` are props of their own.
 */
export function sliderLook(o: SliderLookOptions = {}) {
  const vertical = !!o.vertical;
  const pointer = platform.idiom === "desktop";
  const rail = `${vertical ? "w-2" : "h-2"} rounded-full bg-track dark:bg-inset`;
  const focus = "focus-within:ring-2 focus-within:ring-brand/36 focus-within:ring-offset-2 focus-within:ring-offset-card";
  const fade = "transition duration-150 motion-reduce:transition-none";
  const railStyle = (): ViewStyle => ({
    boxShadow: `inset 0 1px 1px rgba(255, 255, 255, 0.04), 0 0 14px ${alpha(colors.accent, 0.06)}`,
  });
  const track = pointer ? `${rail} ${vertical ? "h-32 py-2" : "px-2"} ${focus}` : vertical ? "w-8 h-36 items-center" : "h-8 justify-center";
  return {
    class: o.value ? "flex-row items-center gap-2" : undefined,
    trackClass: `${track} ${o.value ? "flex-1" : ""} cursor-pointer ${fade} disabled:opacity-35 disabled:cursor-not-allowed`,
    get trackStyle(): ViewStyle | undefined {
      return pointer ? railStyle() : undefined;
    },
    indicatorClass: pointer ? (vertical ? "flex-1" : "h-full") : `${rail} ${vertical ? "h-full" : ""} ${focus}`,
    get indicatorStyle(): ViewStyle | undefined {
      return pointer ? undefined : railStyle();
    },
    // From the rail's own edge, past the thumbs' inset, with a pointer.
    rangeClass: `rounded-full ${pointer ? (vertical ? "-mb-2" : "-ml-2") : ""}`,
    // `focus:` has the platform report the thumb's keyboard focus, which the
    // rail's `focus-within:` ring follows, and drops its default outline.
    thumbClass: `${vertical ? "w-2 h-4" : "w-4 h-2"} rounded-full ${fade} hover:brightness-110 active:brightness-125 focus:outline-none disabled:brightness-100`,
    get thumbStyle(): ViewStyle {
      return {
        backgroundColor: colors.faint,
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.42)",
      };
    },
  };
}

/**
 * A `Slider`'s fill (`rangeStyle`), after BJORK UI's: the accent, deepening
 * toward the fill's start and fading into the thumb's tone at the thumb,
 * the accent stopping 14% of the track before it. `from` and `to` are where
 * the fill starts and ends along the track, from 0 to 1 (a single value's
 * starts at 0).
 */
export function sliderFill(from: number, to: number, vertical = false): ViewStyle {
  const length = Math.max(to - from, 0);
  const accentAt = length > 0 ? (Math.max(length - 0.14, 0) / length) * 100 : 0;
  const deep = `color-mix(in oklab, ${colors.accent} 80%, black)`;
  return {
    backgroundImage: `linear-gradient(${vertical ? 0 : 90}deg, ${deep} 0%, ${colors.accent} ${accentAt}%, ${colors.faint} 100%)`,
  };
}
