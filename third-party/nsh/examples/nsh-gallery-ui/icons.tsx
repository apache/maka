import { Canvas, type CanvasRenderingContext2D } from "nsh";

/** Line glyphs drawn in a 20 × 20 box with the tint as stroke. */
export type IconName =
  | "photos"
  | "lists"
  | "scroll"
  | "nav"
  | "form"
  | "mobile"
  | "components"
  | "controls"
  | "gestures"
  | "physics"
  | "animation"
  | "image"
  | "canvas"
  | "tailwind"
  | "styles"
  | "text"
  | "media"
  | "system"
  | "storage"
  | "stocks"
  | "chat"
  | "chevron"
  | "chevron-up"
  | "chevron-down"
  | "back"
  | "check"
  | "plus"
  | "minus"
  | "arrow-up"
  | "arrow-down"
  | "play"
  | "pause"
  | "search"
  | "star"
  | "bell"
  | "spark"
  | "sidebar"
  | "sun"
  | "moon"
  | "code"
  | "sliders"
  | "stepper"
  | "otp"
  | "panel-bottom"
  | "replace"
  | "replace-all"
  | "diagnostics"
  | "close"
  | "checkbox"
  | "radio"
  | "switch"
  | "tabs"
  | "select"
  | "collapsible"
  | "progress"
  | "chart"
  | "layers"
  | "document"
  | "richtext"
  | "diff"
  | "table"
  | "menu"
  | "dock"
  | "header"
  | "terminal"
  | "popover"
  | "tooltip"
  | "sheet"
  | "button";

type Draw = (cx: CanvasRenderingContext2D) => void;

const line = (cx: CanvasRenderingContext2D, points: number[]) => {
  cx.beginPath();
  cx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) cx.lineTo(points[i], points[i + 1]);
  cx.stroke();
};
const rect = (cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  cx.beginPath();
  cx.roundRect(x, y, w, h, r);
  cx.stroke();
};
const circle = (cx: CanvasRenderingContext2D, x: number, y: number, r: number, fill = false) => {
  cx.beginPath();
  cx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) cx.fill();
  else cx.stroke();
};

const glyphs: Record<IconName, Draw> = {
  popover: (c) => {
    rect(c, 3, 3, 14, 9, 2.5);
    line(c, [8, 12, 10, 14.5, 12, 12]);
    rect(c, 7, 16, 6, 2, 1);
  },
  tooltip: (c) => {
    rect(c, 3, 4, 14, 8, 2.5);
    line(c, [8.5, 12, 10, 14, 11.5, 12]);
    line(c, [6.5, 8, 13.5, 8]);
  },
  sheet: (c) => {
    rect(c, 2.5, 3, 15, 14, 2.5);
    line(c, [2.5, 10, 17.5, 10]);
    line(c, [8.5, 12.5, 11.5, 12.5]);
  },
  button: (c) => {
    rect(c, 2.5, 6, 15, 8, 3);
    line(c, [7, 10, 13, 10]);
  },
  checkbox: (c) => {
    rect(c, 3.5, 3.5, 13, 13, 3);
    line(c, [6.5, 10, 9, 12.5, 13.5, 7.5]);
  },
  radio: (c) => {
    circle(c, 10, 10, 6.5);
    circle(c, 10, 10, 2.4, true);
  },
  switch: (c) => {
    rect(c, 2.5, 6, 15, 8, 4);
    circle(c, 13.5, 10, 2.2, true);
  },
  tabs: (c) => {
    rect(c, 2.5, 5, 15, 11, 2.5);
    line(c, [2.5, 9, 17.5, 9]);
    line(c, [8, 5, 8, 9]);
  },
  select: (c) => {
    // A closed field and its up / down chevrons.
    rect(c, 2.5, 5.5, 15, 9, 2.5);
    line(c, [12, 9, 13.75, 7.5, 15.5, 9]);
    line(c, [12, 11, 13.75, 12.5, 15.5, 11]);
  },
  collapsible: (c) => {
    line(c, [4, 5, 16, 5]);
    line(c, [6, 9, 10, 13, 14, 9]);
    line(c, [4, 16, 16, 16]);
  },
  progress: (c) => {
    rect(c, 2.5, 8, 15, 4, 2);
    line(c, [4.5, 10, 10.5, 10]);
  },
  chart: (c) => {
    line(c, [3, 3, 3, 17, 17, 17]);
    line(c, [6, 13, 9, 9, 12, 11, 16, 5]);
  },
  layers: (c) => {
    line(c, [10, 3, 17, 7, 10, 11, 3, 7, 10, 3]);
    line(c, [3, 10.5, 10, 14.5, 17, 10.5]);
    line(c, [3, 14, 10, 18, 17, 14]);
  },
  document: (c) => {
    rect(c, 4.5, 2.5, 11, 15, 2.5);
    line(c, [7.5, 7, 12.5, 7]);
    line(c, [7.5, 10, 12.5, 10]);
    line(c, [7.5, 13, 10.5, 13]);
  },
  richtext: (c) => {
    line(c, [4, 5, 4, 4, 12, 4, 12, 5]);
    line(c, [8, 4, 8, 15]);
    line(c, [6.5, 15, 9.5, 15]);
    line(c, [13, 11, 17, 11]);
    line(c, [13, 15, 17, 15]);
  },
  diff: (c) => {
    line(c, [6, 3, 6, 9]);
    line(c, [3, 6, 9, 6]);
    line(c, [3, 15, 9, 15]);
    line(c, [12, 3, 12, 17]);
    line(c, [14, 7, 17, 7]);
    line(c, [14, 13, 17, 13]);
  },
  table: (c) => {
    rect(c, 2.5, 3.5, 15, 13, 2.5);
    line(c, [2.5, 8, 17.5, 8]);
    line(c, [2.5, 12.5, 17.5, 12.5]);
    line(c, [8, 3.5, 8, 16.5]);
  },
  menu: (c) => {
    rect(c, 3.5, 2.5, 13, 15, 2.5);
    line(c, [6.5, 6.5, 13.5, 6.5]);
    line(c, [6.5, 10, 13.5, 10]);
    line(c, [6.5, 13.5, 11, 13.5]);
  },
  dock: (c) => {
    rect(c, 2.5, 3.5, 15, 13, 2.5);
    line(c, [7.5, 3.5, 7.5, 16.5]);
    line(c, [7.5, 11, 17.5, 11]);
  },
  header: (c) => {
    rect(c, 3.5, 2.5, 13, 15, 2.5);
    line(c, [3.5, 7, 16.5, 7]);
    line(c, [10, 10, 10, 15]);
    line(c, [8, 13, 10, 15, 12, 13]);
  },
  terminal: (c) => {
    rect(c, 2.5, 3.5, 15, 13, 2.5);
    line(c, [6, 8, 8.5, 10, 6, 12]);
    line(c, [10.5, 13, 14, 13]);
  },
  photos: (c) => {
    rect(c, 3, 4, 14, 12, 3);
    line(c, [3, 13, 8, 9, 12, 12, 14, 10, 17, 13]);
    circle(c, 13, 7.5, 1.2);
  },
  lists: (c) => {
    for (const y of [5, 10, 15]) {
      circle(c, 4.5, y, 1.1, true);
      line(c, [8, y, 17, y]);
    }
  },
  scroll: (c) => {
    rect(c, 5, 2.5, 10, 15, 3);
    line(c, [10, 6, 10, 9]);
    line(c, [8, 12, 10, 14, 12, 12]);
  },
  nav: (c) => {
    rect(c, 2.5, 4, 9, 12, 2.5);
    rect(c, 8.5, 4, 9, 12, 2.5);
    line(c, [12, 10, 15, 10]);
  },
  form: (c) => {
    rect(c, 3, 4, 14, 5, 2);
    rect(c, 3, 11, 14, 5, 2);
    line(c, [6, 6.5, 6, 6.5]);
    line(c, [5.5, 13.5, 9, 13.5]);
  },
  mobile: (c) => {
    rect(c, 5.5, 2.5, 9, 15, 2.5);
    line(c, [9, 15, 11, 15]);
  },
  components: (c) => {
    rect(c, 3, 3, 6, 6, 1.6);
    rect(c, 11, 3, 6, 6, 1.6);
    rect(c, 3, 11, 6, 6, 1.6);
    circle(c, 14, 14, 3);
  },
  controls: (c) => {
    // A switch over a checked box.
    rect(c, 3, 3.5, 14, 6, 3);
    circle(c, 14, 6.5, 1.6, true);
    rect(c, 3, 11.5, 5, 5, 1.4);
    line(c, [4.3, 14, 5.3, 15, 6.9, 13]);
    line(c, [10.5, 14, 17, 14]);
  },
  gestures: (c) => {
    line(c, [8, 17, 8, 7.5, 10, 6, 11, 7.5, 11, 11]);
    line(c, [11, 10, 13, 9.5, 14, 11, 14, 14, 12, 17]);
    line(c, [5, 4, 3.5, 2.5]);
    line(c, [11, 3, 12.5, 1.5]);
  },
  physics: (c) => {
    circle(c, 10, 6, 3);
    line(c, [3, 16, 17, 16]);
    line(c, [6, 12, 6, 12.1]);
    c.setLineDash([1.5, 2]);
    line(c, [10, 9, 10, 15]);
    c.setLineDash([]);
  },
  animation: (c) => {
    line(c, [3, 15, 7, 15, 13, 5, 17, 5]);
    circle(c, 13, 5, 1.6, true);
  },
  image: (c) => {
    rect(c, 3, 3.5, 14, 13, 3);
    line(c, [3, 14, 8, 9, 13, 14]);
    line(c, [11, 12, 13, 10, 17, 14]);
  },
  canvas: (c) => {
    line(c, [4, 16, 6, 11, 14, 3, 17, 6, 9, 14, 4, 16]);
    line(c, [12.5, 4.5, 15.5, 7.5]);
  },
  tailwind: (c) => {
    line(c, [3, 9, 5, 6, 8, 6, 10, 8, 12, 10, 15, 10, 17, 7]);
    line(c, [3, 14, 5, 11, 8, 11, 10, 13, 12, 15, 15, 15, 17, 12]);
  },
  styles: (c) => {
    rect(c, 3, 3, 9, 9, 2);
    c.beginPath();
    c.roundRect(8, 8, 9, 9, 4.5);
    c.stroke();
  },
  text: (c) => {
    line(c, [4, 5, 16, 5]);
    line(c, [10, 5, 10, 16]);
    line(c, [7.5, 16, 12.5, 16]);
  },
  media: (c) => {
    rect(c, 2.5, 4, 15, 12, 3);
    line(c, [8.5, 7.5, 12.5, 10, 8.5, 12.5, 8.5, 7.5]);
  },
  system: (c) => {
    circle(c, 10, 10, 3);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      line(c, [10 + Math.cos(a) * 5.5, 10 + Math.sin(a) * 5.5, 10 + Math.cos(a) * 7.5, 10 + Math.sin(a) * 7.5]);
    }
  },
  storage: (c) => {
    c.beginPath();
    c.ellipse(10, 5, 6, 2.2, 0, 0, Math.PI * 2);
    c.stroke();
    line(c, [4, 5, 4, 15]);
    line(c, [16, 5, 16, 15]);
    for (const y of [10, 15]) {
      c.beginPath();
      c.ellipse(10, y, 6, 2.2, 0, 0, Math.PI);
      c.stroke();
    }
  },
  stocks: (c) => {
    line(c, [6, 4, 6, 16]);
    rect(c, 4.5, 7, 3, 5, 0.8);
    line(c, [13, 3, 13, 15]);
    rect(c, 11.5, 5, 3, 7, 0.8);
    line(c, [3, 17.5, 17, 17.5]);
  },
  chat: (c) => {
    line(c, [6, 16.5, 6, 14, 5, 14, 3, 12, 3, 6, 5, 4, 15, 4, 17, 6, 17, 12, 15, 14, 9, 14, 6, 16.5]);
    line(c, [7, 8, 13, 8]);
    line(c, [7, 10.5, 11, 10.5]);
  },
  chevron: (c) => line(c, [7.5, 5, 12.5, 10, 7.5, 15]),
  "chevron-up": (c) => line(c, [5, 12.5, 10, 7.5, 15, 12.5]),
  "chevron-down": (c) => line(c, [5, 7.5, 10, 12.5, 15, 7.5]),
  back: (c) => line(c, [12.5, 5, 7.5, 10, 12.5, 15]),
  check: (c) => line(c, [4.5, 10.5, 8.5, 14, 15.5, 6]),
  plus: (c) => {
    line(c, [10, 4, 10, 16]);
    line(c, [4, 10, 16, 10]);
  },
  minus: (c) => line(c, [4, 10, 16, 10]),
  "arrow-up": (c) => {
    line(c, [10, 16, 10, 4]);
    line(c, [5, 9, 10, 4, 15, 9]);
  },
  "arrow-down": (c) => {
    line(c, [10, 4, 10, 16]);
    line(c, [5, 11, 10, 16, 15, 11]);
  },
  play: (c) => {
    c.beginPath();
    c.moveTo(6.5, 4.5);
    c.lineTo(15.5, 10);
    c.lineTo(6.5, 15.5);
    c.closePath();
    c.fill();
  },
  pause: (c) => {
    c.fillRect(5.5, 4.5, 3, 11);
    c.fillRect(11.5, 4.5, 3, 11);
  },
  search: (c) => {
    circle(c, 8.5, 8.5, 5);
    line(c, [12.3, 12.3, 16.5, 16.5]);
  },
  star: (c) => {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 3.2 : 7;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      if (i) c.lineTo(10 + Math.cos(a) * r, 10.5 + Math.sin(a) * r);
      else c.moveTo(10 + Math.cos(a) * r, 10.5 + Math.sin(a) * r);
    }
    c.closePath();
    c.stroke();
  },
  bell: (c) => {
    line(c, [5, 14, 5, 9, 7, 5.5, 10, 4.5, 13, 5.5, 15, 9, 15, 14, 5, 14]);
    line(c, [8.5, 16.5, 11.5, 16.5]);
  },
  spark: (c) => {
    line(c, [10, 3, 11.5, 8.5, 17, 10, 11.5, 11.5, 10, 17, 8.5, 11.5, 3, 10, 8.5, 8.5, 10, 3]);
  },
  sidebar: (c) => {
    rect(c, 3, 4, 14, 12, 3);
    line(c, [8, 4, 8, 16]);
  },
  sun: (c) => {
    c.beginPath();
    c.arc(10, 10, 3.4, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      line(c, [10 + Math.cos(a) * 6, 10 + Math.sin(a) * 6, 10 + Math.cos(a) * 7.8, 10 + Math.sin(a) * 7.8]);
    }
  },
  code: (c) => {
    line(c, [7, 6, 3, 10, 7, 14]);
    line(c, [13, 6, 17, 10, 13, 14]);
    line(c, [11.5, 4.5, 8.5, 15.5]);
  },
  stepper: (c) => {
    // A field with its minus and plus.
    rect(c, 2.5, 5.5, 15, 9, 2.5);
    line(c, [10, 5.5, 10, 14.5]);
    line(c, [4.5, 10, 7.5, 10]);
    line(c, [12.5, 10, 15.5, 10]);
    line(c, [14, 8.5, 14, 11.5]);
  },
  otp: (c) => {
    // Four cells, two of them filled.
    for (const [i, x] of [2, 6.25, 10.5, 14.75].entries()) {
      rect(c, x, 6, 3.25, 8, 1);
      if (i < 2) {
        c.beginPath();
        c.arc(x + 1.625, 10, 0.9, 0, Math.PI * 2);
        c.fill();
      }
    }
  },
  sliders: (c) => {
    for (const [y, x] of [[6, 12.5], [14, 7.5]]) {
      line(c, [3, y, 17, y]);
      c.beginPath();
      c.arc(x, y, 2, 0, Math.PI * 2);
      c.fill();
    }
  },
  "panel-bottom": (c) => {
    rect(c, 3, 4, 14, 12, 3);
    line(c, [3, 12, 17, 12]);
  },
  replace: (c) => {
    // An arrow turning into the box of the new text.
    line(c, [4, 4, 4, 11, 11.5, 11]);
    line(c, [9, 8.5, 11.5, 11, 9, 13.5]);
    rect(c, 13.5, 8, 3.5, 6, 1);
  },
  "replace-all": (c) => {
    line(c, [4, 4, 4, 10, 11.5, 10]);
    line(c, [9, 7.5, 11.5, 10, 9, 12.5]);
    rect(c, 13.5, 3.5, 3.5, 5.5, 1);
    rect(c, 13.5, 11, 3.5, 5.5, 1);
  },
  diagnostics: (c) => {
    line(c, [10, 3.5, 17, 16, 3, 16, 10, 3.5]);
    line(c, [10, 8, 10, 11.5]);
    circle(c, 10, 13.8, 0.7, true);
  },
  close: (c) => {
    line(c, [5.5, 5.5, 14.5, 14.5]);
    line(c, [14.5, 5.5, 5.5, 14.5]);
  },
  moon: (c) => {
    // A disc less the one up and to its right: the arcs meet where the circles cross.
    c.beginPath();
    c.arc(10, 10, 6.5, 0.134, Math.PI * 2 - 1.704);
    c.arc(13.2, 6.8, 5.2, Math.PI * 2 - 2.468, 0.898, true);
    c.closePath();
    c.stroke();
  },
};

/** A glyph, stroked with `tint`; `weight` is the stroke in the glyphs' 20-unit box (1.6 by default). */
export function Icon(props: { name: IconName; size?: number; tint: string; weight?: number }) {
  const size = props.size ?? 20;
  return (
    <Canvas
      style={{ pointerEvents: "none", width: size, height: size }}
      draw={(cx, { width }) => {
        cx.scale(width / 20, width / 20);
        cx.strokeStyle = props.tint;
        cx.fillStyle = props.tint;
        cx.lineWidth = props.weight ?? 1.6;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        glyphs[props.name](cx);
      }}
    />
  );
}
