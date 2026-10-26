import { type CanvasRenderingContext2D, effect, type JSX, type PanActivation, Text, type TouchProps, untracked, View } from "nsh";
import { Animated, createAnimatedValue, Easing, type AnimatedNode } from "nsh";
import { PanResponder } from "nsh";
import { alpha, colors, isDark } from "../../ui";
import type { Quote } from "./market";

/**
 * A background that flashes green or red when the quote changes and fades
 * on the UI thread: JS only kicks the value, it never animates it. Read it
 * in the style: the colors follow the appearance.
 */
export function flash(quote: () => Quote): () => AnimatedNode {
  const v = createAnimatedValue(0);
  let seen = untracked(quote).changedAt;
  effect(() => {
    const q = quote();
    if (q.changedAt === seen) return;
    seen = q.changedAt;
    v.set(q.dir);
    v.timing(0, { duration: 700, easing: Easing.out(Easing.quad) });
  });
  // A strong tint at ±1 that fades to clear at 0.
  return () =>
    v.interpolate({
      inputRange: [-1, -0.01, 0.01, 1],
      outputRange: [alpha(colors.down, 0.34), alpha(colors.down, 0), alpha(colors.up, 0), alpha(colors.up, 0.34)],
    });
}

/**
 * An opacity that dips and recovers natively when the quote changes: a
 * blink on the price text, no background.
 */
export function blink(quote: () => Quote): AnimatedNode {
  const v = createAnimatedValue(1);
  let seen = untracked(quote).changedAt;
  effect(() => {
    const q = quote();
    if (q.changedAt === seen) return;
    seen = q.changedAt;
    v.set(0.45);
    v.timing(1, { duration: 450, easing: Easing.out(Easing.quad) });
  });
  return v;
}

/**
 * A pulse that loops natively while `running()`: 0 → 1 over 1.4 s, for a
 * ring that grows and fades around a live dot.
 */
export function pulse(running: () => boolean) {
  const v = createAnimatedValue(0);
  const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic) }));
  effect(() => {
    if (running()) loop.start();
    else {
      loop.stop();
      v.timing(0, { duration: 200 });
    }
  });
  return v;
}

/** A dot with a ring that pulses while the market runs. */
export function LiveDot(props: { running: () => boolean; size?: number }) {
  const p = pulse(props.running);
  const size = props.size ?? 8;
  return (
    <View style={{ width: size * 2.5, height: size * 2.5, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.accent,
          opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 2.5] }) }],
        }}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: props.running() ? colors.accent : colors.faint }} />
    </View>
  );
}

/**
 * Touch handlers for a chart that scrubs horizontally: the platform gives
 * the chart the finger only once it has moved sideways (`panActivation`,
 * decided natively), so vertical drags still scroll the page. `at(x)` gets
 * the position along the chart, then `null` when the finger lifts.
 */
export function scrub(at: (x: number | null) => void): TouchProps & { panActivation: PanActivation } {
  const handlers = PanResponder.create({
    onPanResponderGrant: (e) => at(e.locationX),
    onPanResponderMove: (e) => at(e.locationX),
    onPanResponderRelease: () => at(null),
    onPanResponderTerminate: () => at(null),
    onPanResponderTerminationRequest: () => false,
  }).panHandlers;
  return { ...handlers, panActivation: { activeOffsetX: 6, failOffsetY: 8 } };
}

/** Diagonal stripes over a rectangle (projections, zones). */
export function hatch(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, gap = 6) {
  if (w <= 0 || h <= 0) return;
  cx.save();
  cx.beginPath();
  cx.rect(x, y, w, h);
  cx.clip();
  cx.strokeStyle = color;
  cx.lineWidth = 1;
  cx.beginPath();
  for (let i = -h; i < w; i += gap) {
    cx.moveTo(x + i, y + h);
    cx.lineTo(x + i + h, y);
  }
  cx.stroke();
  cx.restore();
}

/** A dashed horizontal line. */
export function dashed(cx: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, dash = [3, 4]) {
  cx.strokeStyle = color;
  cx.lineWidth = 1;
  cx.setLineDash(dash);
  cx.beginPath();
  cx.moveTo(x0, y);
  cx.lineTo(x1, y);
  cx.stroke();
  cx.setLineDash([]);
}

export { alpha };

/** Grid lines of charts: the hairline color, a step darker on the light page. */
export const grid = () => (isDark() ? colors.line : colors.border);

/**
 * A bar that grows from one edge of its track to `share()` (0..1) with a
 * native spring: the bar is the track's width and slides in, clipped.
 */
export function SpringBar(props: { share: () => number; color: string; from?: "left" | "right"; height?: number; radius?: number }) {
  const x = createAnimatedValue(0);
  let width = 0;
  let placed = false;
  const place = () => {
    if (!width) return;
    const s = Math.max(0, Math.min(1, props.share()));
    const to = (props.from === "right" ? 1 : -1) * (1 - s) * width;
    if (placed) x.spring(to, { stiffness: 180, damping: 22 });
    else x.set(to);
    placed = true;
  };
  effect(() => {
    props.share();
    untracked(place);
  });
  const h = props.height ?? 8;
  return (
    <View
      onLayout={(e) => {
        width = e.size.width;
        place();
      }}
      style={{ height: h, overflow: "hidden", borderRadius: props.radius ?? h / 2 }}
    >
      <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, borderRadius: props.radius ?? h / 2, backgroundColor: props.color, transform: [{ translateX: x }] }} />
    </View>
  );
}

/**
 * An axis range that follows its data calmly: it widens at once (nothing
 * is clipped) and narrows by `rate` of the gap per call, so a redraw never
 * jumps the scale. `reset` forgets it (another period, another stock).
 */
export function calm(rate: number) {
  let lo = NaN, hi = NaN;
  return {
    fit(l: number, h: number) {
      if (Number.isNaN(lo)) {
        lo = l;
        hi = h;
      } else {
        lo = l < lo ? l : lo + (l - lo) * rate;
        hi = h > hi ? h : hi + (h - hi) * rate;
      }
      return { lo, hi };
    },
    reset() {
      lo = hi = NaN;
    },
  };
}

/**
 * A flat section of a screen: a title with a faint note (or a control) on
 * the right, the content below, a hairline above all but the first.
 */
export function Block(props: { title?: string; note?: JSX.Element; right?: JSX.Element; first?: boolean; gap?: number; children: JSX.Element }) {
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: props.gap ?? 10,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      <If when={props.title}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}>
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
          <If when={props.note}>
            <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text>
          </If>
          {props.right}
        </View>
      </If>
      {props.children}
    </View>
  );
}

/** A quiet header for columns ("SYMBOL", "LAST"). */
export function Head(props: { label: string; width?: number; flex?: number; align?: "left" | "right" | "center" }) {
  return (
    <Text
      style={{
        width: props.width,
        flex: props.flex,
        textAlign: props.align ?? "left",
        fontSize: 11,
        color: colors.faint,
        fontVariant: ["tabular-nums"],
        letterSpacing: 0.6,
      }}
    >
      {props.label}
    </Text>
  );
}
