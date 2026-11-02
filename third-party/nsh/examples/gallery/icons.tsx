// The gallery uses the internal shared icon set, and Lucide's icons where a
// demo needs more (`lucide.ts`, made by `scripts/lucide.py`).
import { Canvas, type CanvasRenderingContext2D, Path2D } from "nsh";
import { lucide, type LucideElement, type LucideName } from "./lucide";

export { Icon, type IconName } from "../nsh-gallery-ui/icons";

/** The Lucide icons the gallery draws. */
export type LucideIconName = LucideName;

/** The numbers of an SVG `points` list, in pairs. */
function points(list: string): number[] {
  return list
    .trim()
    .split(/[\s,]+/)
    .map(Number);
}

/** Draws one element as Lucide's SVG does: stroked, never filled. */
function draw(cx: CanvasRenderingContext2D, el: LucideElement) {
  switch (el.tag) {
    case "path":
      cx.stroke(new Path2D(el.d));
      return;
    case "circle":
      cx.beginPath();
      cx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2);
      break;
    case "ellipse":
      cx.beginPath();
      cx.ellipse(el.cx, el.cy, el.rx, el.ry, 0, 0, Math.PI * 2);
      break;
    case "rect":
      cx.beginPath();
      cx.roundRect(el.x, el.y, el.width, el.height, el.rx ?? 0);
      break;
    case "line":
      cx.beginPath();
      cx.moveTo(el.x1, el.y1);
      cx.lineTo(el.x2, el.y2);
      break;
    case "polyline":
    case "polygon": {
      const p = points(el.points);
      cx.beginPath();
      cx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) cx.lineTo(p[i], p[i + 1]);
      if (el.tag === "polygon") cx.closePath();
      break;
    }
  }
  cx.stroke();
}

/** A Lucide icon on its 24 × 24 grid, stroked with `tint` (width 2, round caps and joins). */
export function LucideIcon(props: { name: LucideIconName; size?: number; tint: string }) {
  const size = props.size ?? 20;
  return (
    <Canvas
      style={{ pointerEvents: "none", width: size, height: size }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.lineWidth = 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        for (const el of lucide[props.name] as LucideElement[]) draw(cx, el);
      }}
    />
  );
}
