import { Canvas, type CanvasRenderingContext2D } from "nsh";

/** The chat's own line glyphs, drawn like `Icon`'s in a 20 × 20 box. */
export type GlyphName =
  | "copy"
  | "regenerate"
  | "thumb-up"
  | "thumb-down"
  | "stop"
  | "globe"
  | "sun"
  | "terminal"
  | "clip"
  | "close"
  | "caret-down"
  | "alert"
  | "offline"
  | "check"
  | "brain"
  | "file";

type Draw = (cx: CanvasRenderingContext2D) => void;

const line = (cx: CanvasRenderingContext2D, points: number[]) => {
  cx.beginPath();
  cx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) cx.lineTo(points[i], points[i + 1]);
  cx.stroke();
};
const rect = (cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill = false) => {
  cx.beginPath();
  cx.roundRect(x, y, w, h, r);
  if (fill) cx.fill();
  else cx.stroke();
};
const arc = (cx: CanvasRenderingContext2D, x: number, y: number, r: number, from = 0, to = Math.PI * 2) => {
  cx.beginPath();
  cx.arc(x, y, r, from, to);
  cx.stroke();
};
const thumb = (cx: CanvasRenderingContext2D) => {
  rect(cx, 3, 9, 3.2, 8, 1);
  line(cx, [6.2, 9.5, 9.5, 3.5, 11.2, 4, 10.6, 8, 15.4, 8, 16.6, 9.4, 15.4, 16, 14.2, 17, 6.2, 17]);
};

const glyphs: Record<GlyphName, Draw> = {
  copy: (c) => {
    rect(c, 7, 7, 10, 10, 2.5);
    line(c, [13, 4.5, 13, 4, 12, 3, 4, 3, 3, 4, 3, 12, 4, 13, 4.5, 13]);
  },
  regenerate: (c) => {
    arc(c, 10, 10, 6, -Math.PI * 0.25, Math.PI * 1.45);
    line(c, [14.5, 2.5, 14.5, 6, 11, 6]);
  },
  "thumb-up": thumb,
  "thumb-down": (c) => {
    c.translate(0, 20);
    c.scale(1, -1);
    thumb(c);
  },
  stop: (c) => rect(c, 5, 5, 10, 10, 2.5, true),
  globe: (c) => {
    arc(c, 10, 10, 7);
    c.beginPath();
    c.ellipse(10, 10, 3, 7, 0, 0, Math.PI * 2);
    c.stroke();
    line(c, [3, 10, 17, 10]);
  },
  sun: (c) => {
    arc(c, 10, 10, 3.5);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      line(c, [10 + Math.cos(a) * 6, 10 + Math.sin(a) * 6, 10 + Math.cos(a) * 8, 10 + Math.sin(a) * 8]);
    }
  },
  terminal: (c) => {
    rect(c, 2.5, 4, 15, 12, 2.5);
    line(c, [6, 8, 8.5, 10, 6, 12]);
    line(c, [10.5, 12.5, 14, 12.5]);
  },
  clip: (c) => line(c, [13.5, 6.5, 7.5, 12.5, 7.5, 14, 9, 14.5, 15.5, 8, 15.5, 5, 13, 3.5, 11, 3.5, 4.5, 10, 4, 13, 5, 15.5, 8, 16.5, 11, 15.5, 16, 10.5]),
  close: (c) => {
    line(c, [5.5, 5.5, 14.5, 14.5]);
    line(c, [14.5, 5.5, 5.5, 14.5]);
  },
  "caret-down": (c) => line(c, [6, 8, 10, 12, 14, 8]),
  alert: (c) => {
    arc(c, 10, 10, 7);
    line(c, [10, 6, 10, 11]);
    line(c, [10, 13.8, 10, 14]);
  },
  offline: (c) => {
    arc(c, 10, 16, 9, -Math.PI * 0.78, -Math.PI * 0.22);
    arc(c, 10, 16, 5.2, -Math.PI * 0.75, -Math.PI * 0.25);
    line(c, [10, 15.5, 10, 15.6]);
    line(c, [3.5, 3.5, 16.5, 16.5]);
  },
  check: (c) => line(c, [4.5, 10.5, 8.5, 14, 15.5, 6]),
  brain: (c) => {
    c.beginPath();
    c.moveTo(10, 4.5);
    c.bezierCurveTo(5, 2.5, 2.5, 7, 4.5, 10);
    c.bezierCurveTo(2.5, 13.5, 6, 17, 10, 15.5);
    c.bezierCurveTo(14, 17, 17.5, 13.5, 15.5, 10);
    c.bezierCurveTo(17.5, 7, 15, 2.5, 10, 4.5);
    c.stroke();
    line(c, [10, 4.5, 10, 15.5]);
  },
  file: (c) => {
    line(c, [5, 3, 12, 3, 15.5, 6.5, 15.5, 17, 5, 17, 5, 3]);
    line(c, [12, 3, 12, 6.5, 15.5, 6.5]);
  },
};

/** A chat glyph, stroked with `tint`. */
export function Glyph(props: { name: GlyphName; size?: number; tint: string }) {
  const size = props.size ?? 20;
  return (
    <Canvas
      style={{ pointerEvents: "none", width: size, height: size }}
      draw={(cx, { width }) => {
        cx.scale(width / 20, width / 20);
        cx.strokeStyle = props.tint;
        cx.fillStyle = props.tint;
        cx.lineWidth = 1.6;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        glyphs[props.name](cx);
      }}
    />
  );
}
