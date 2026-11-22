import { Canvas, type CanvasRenderingContext2D } from "nsh";
import { color } from "./theme";

/** Glyphs drawn in a 20 × 20 box with the tint as stroke. */
export type IconName = "hops" | "mass" | "plan" | "throttle" | "tilt" | "rcs" | "chevron" | "back" | "check" | "caret";

const path = (cx: CanvasRenderingContext2D, points: [number, number][], close = false) => {
  cx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y)));
  if (close) cx.closePath();
  cx.stroke();
};

const glyphs: Record<IconName, (cx: CanvasRenderingContext2D) => void> = {
  // An arc from the ground and back: a hop.
  hops: (cx) => {
    cx.beginPath();
    cx.moveTo(3, 16);
    cx.quadraticCurveTo(10, -1, 17, 16);
    cx.stroke();
    path(cx, [[2, 17], [18, 17]]);
  },
  // The lander's outline.
  mass: (cx) => {
    path(cx, [[10, 2], [13, 6], [13, 14], [7, 14], [7, 6]], true);
    path(cx, [[7, 12], [4, 17]]);
    path(cx, [[13, 12], [16, 17]]);
  },
  // Waypoints joined by a route.
  plan: (cx) => {
    path(cx, [[4, 15], [9, 7], [16, 5]]);
    for (const [x, y] of [[4, 15], [9, 7], [16, 5]]) {
      cx.beginPath();
      cx.arc(x, y, 1.8, 0, Math.PI * 2);
      cx.stroke();
    }
  },
  throttle: (cx) => {
    cx.beginPath();
    cx.moveTo(3, 16);
    cx.bezierCurveTo(8, 16, 7, 4, 17, 4);
    cx.stroke();
    path(cx, [[3, 3], [3, 17], [17, 17]]);
  },
  // An artificial horizon.
  tilt: (cx) => {
    cx.beginPath();
    cx.arc(10, 10, 7.5, 0, Math.PI * 2);
    cx.stroke();
    path(cx, [[3.5, 12], [16.5, 8]]);
  },
  // Four thruster blocks around a hull.
  rcs: (cx) => {
    cx.beginPath();
    cx.arc(10, 10, 4, 0, Math.PI * 2);
    cx.stroke();
    for (const [x, y] of [[3, 3], [15, 3], [3, 15], [15, 15]]) cx.strokeRect(x, y, 2.5, 2.5);
  },
  chevron: (cx) => path(cx, [[8, 5], [13, 10], [8, 15]]),
  back: (cx) => path(cx, [[12, 5], [7, 10], [12, 15]]),
  check: (cx) => path(cx, [[4, 10.5], [8, 14.5], [16, 5.5]]),
  caret: (cx) => path(cx, [[6, 8], [10, 12], [14, 8]]),
};

/** A glyph drawn natively; `flip` turns it upside down (an open caret). */
export function Icon(props: { name: IconName; size?: number; tint?: string; flip?: boolean }) {
  const size = props.size ?? 20;
  return (
    <Canvas
      style={{ width: size, height: size }}
      draw={(cx) => {
        cx.scale(size / 20, size / 20);
        if (props.flip) {
          cx.translate(20, 20);
          cx.rotate(Math.PI);
        }
        cx.strokeStyle = props.tint ?? color.text;
        cx.lineWidth = 1.6;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        glyphs[props.name](cx);
      }}
    />
  );
}
