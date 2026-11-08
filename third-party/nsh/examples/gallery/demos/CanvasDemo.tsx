import { Canvas, type CanvasRenderingContext2D, cleanup, type GestureResponderEvent, Path2D, signal, Text, View } from "nsh";
import { Animated, createAnimatedValue, Easing, type AnimatedValue } from "nsh";
import logo from "../logo@2x.png";
import { alpha, Button, Caption, Card, colors, DemoPage, Figure, finish, hint, isDark, Legend, type Palette, Segmented, Stat, terminal } from "../ui";

const TAU = Math.PI * 2;
const SANS = (size: number, weight = "400") => `${weight} ${size}px system-ui`;

/** The accent as rgba, for low-alpha fills. */
const accentA = (a: number) => alpha(colors.accent, a);
const infoA = (a: number) => alpha(colors.info, a);

/** A small seeded random generator, so the fictional data is stable. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Diagonal hatching over the current clip (call inside save / clip / restore). */
function hatch(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, gap = 6) {
  cx.strokeStyle = color;
  cx.lineWidth = 1;
  cx.beginPath();
  for (let i = -h; i < w; i += gap) {
    cx.moveTo(x + i, y + h);
    cx.lineTo(x + i + h, y);
  }
  cx.stroke();
}

/** A dashed horizontal or vertical reference line. */
function dashed(cx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string = colors.border) {
  cx.save();
  cx.setLineDash([3, 4]);
  cx.strokeStyle = color;
  cx.lineWidth = 1;
  cx.beginPath();
  cx.moveTo(x0, y0);
  cx.lineTo(x1, y1);
  cx.stroke();
  cx.restore();
}

/** A value that sweeps 0 → 1 once mounted (and again on `replay`): canvases clip to it. */
function reveal(duration = 900) {
  const t = createAnimatedValue(0);
  const replay = () => {
    t.set(0);
    t.timing(1, { duration, easing: Easing.out(Easing.cubic) });
  };
  replay();
  return { t, replay };
}

// ---------------------------------------------------------------------------
// A dial: a tick ring, a hatched red zone, a gradient sweep and a needle, all
// bound to one animated value. Springing it moves the needle on the UI thread.

const presets = [
  { value: "idle", label: "Idle", load: 18 },
  { value: "cruise", label: "Cruise", load: 57 },
  { value: "peak", label: "Peak", load: 91 },
] as const;
type Preset = (typeof presets)[number]["value"];

function Dial() {
  const preset = signal<Preset>("cruise");
  const load = () => presets.find((p) => p.value === preset())!.load;
  const needle = createAnimatedValue(0);
  needle.spring(load(), { stiffness: 90, damping: 9 });
  const choose = (p: Preset) => {
    preset.set(p);
    needle.spring(load(), { stiffness: 140, damping: 11 });
  };
  const a0 = 0.75 * Math.PI;
  const a1 = 2.25 * Math.PI;
  const angle = needle.interpolate({ inputRange: [0, 100], outputRange: [a0, a1] });
  const zone = () => (load() >= 85 ? "danger" : load() >= 60 ? "warn" : "up");
  return (
    <Card icon="spark" title="Turbine 3 load" subtitle="Needle and sweep on one animated value">
      <Canvas
        style={{ height: 230 }}
        draw={(cx, { width, height }) => {
          const centerX = width / 2;
          const cy = height * 0.54;
          const r = Math.min(width / 2 - 8, height * 0.5) - 6;
          const at = (v: number) => a0 + (v / 100) * (a1 - a0);
          // The red zone: an annular sector, hatched.
          cx.save();
          cx.beginPath();
          cx.arc(centerX, cy, r + 2, at(85), a1);
          cx.arc(centerX, cy, r - 20, a1, at(85), true);
          cx.closePath();
          cx.clip();
          cx.fillStyle = alpha(colors.danger, 0.08);
          // The zone sits right of the hub, from just above it to 45° below.
          const zx = centerX + 0.6 * r, zy = cy - 0.2 * r, zw = 0.4 * r + 4, zh = r;
          cx.fillRect(zx, zy, zw, zh);
          hatch(cx, zx, zy, zw, zh, alpha(colors.danger, 0.55), 5);
          cx.restore();
          // The tick ring.
          for (let i = 0; i <= 50; i++) {
            const a = at(i * 2);
            const major = i % 10 === 0;
            const inner = r - (major ? 14 : 8);
            cx.strokeStyle = i * 2 >= 85 ? colors.danger : major ? colors.muted : colors.faint;
            cx.lineWidth = major ? 2 : 1;
            cx.lineCap = "round";
            cx.beginPath();
            cx.moveTo(centerX + Math.cos(a) * inner, cy + Math.sin(a) * inner);
            cx.lineTo(centerX + Math.cos(a) * r, cy + Math.sin(a) * r);
            cx.stroke();
            if (major) {
              const label = String(i * 2);
              cx.font = SANS(11);
              cx.fillStyle = colors.faint;
              cx.textAlign = "center";
              cx.textBaseline = "middle";
              cx.fillText(label, centerX + Math.cos(a) * (r - 28), cy + Math.sin(a) * (r - 28));
            }
          }
          // The sweep: a track, then a conic gradient arc ending at the needle.
          const sr = r + 12;
          cx.lineWidth = 5;
          cx.lineCap = "round";
          cx.strokeStyle = colors.raised;
          cx.beginPath();
          cx.arc(centerX, cy, sr, a0, a1);
          cx.stroke();
          const g = cx.createConicGradient(a0 - 0.2, centerX, cy);
          g.addColorStop(0, colors.info);
          g.addColorStop(0.45, colors.accent);
          g.addColorStop(0.75, colors.warn);
          g.addColorStop(0.8, colors.danger);
          cx.strokeStyle = g;
          cx.beginPath();
          cx.arc(centerX, cy, sr, a0, angle);
          cx.stroke();
          // The readout (redrawn only when the preset changes).
          cx.textAlign = "center";
          cx.textBaseline = "alphabetic";
          cx.font = SANS(40, "600");
          cx.fillStyle = colors.text;
          cx.fillText(String(load()), centerX, cy + r * 0.62);
          cx.font = SANS(11);
          cx.fillStyle = colors.faint;
          cx.fillText("% load", centerX, cy + r * 0.62 + 18);
          // The needle, rotated natively.
          cx.save();
          cx.translate(centerX, cy);
          cx.rotate(angle);
          cx.shadowColor = isDark() ? "rgba(0,0,0,0.6)" : "rgba(16,20,30,0.3)";
          cx.shadowBlur = 6;
          cx.fillStyle = colors.text;
          cx.beginPath();
          cx.moveTo(-14, -3);
          cx.lineTo(r - 18, 0);
          cx.lineTo(-14, 3);
          cx.closePath();
          cx.fill();
          cx.restore();
          cx.fillStyle = colors.raised;
          cx.strokeStyle = colors.text;
          cx.lineWidth = 2;
          cx.beginPath();
          cx.arc(centerX, cy, 7, 0, TAU);
          cx.fill();
          cx.stroke();
        }}
      />
      <Segmented options={presets} value={preset()} onChange={choose} />
      <View style={{ flexDirection: "row" }}>
        <Stat width="33%" label="Zone" value={zone() === "danger" ? "Redline" : zone() === "warn" ? "High" : "Nominal"} tone={zone()} />
        <Stat width="33%" label="Spool" value={`${(load() * 128).toLocaleString()} rpm`} />
        <Stat width="33%" label="Limit" value="85 %" tone="danger" />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// An area chart: gradient fill, a line, a dashed average, a hatched window,
// labels measured with measureText. New data sweeps in natively.

const fresh = (rand = Math.random) => Array.from({ length: 14 }, (_, i) => Math.round(28 + 40 * Math.sin(i / 2.2) ** 2 + rand() * 26));

function AreaChart() {
  const data = signal(fresh(seeded(7)));
  const sweep = reveal(1100);
  const last = () => data()[data().length - 1];
  const avg = () => Math.round(data().reduce((a, b) => a + b, 0) / data().length);
  return (
    <Card
      icon="stocks"
      title="Relay throughput"
      subtitle="Area · average · hatching"
      right={<Button label="New" variant="secondary" onPress={() => (data.set(fresh()), sweep.replay())} />}
    >
      <Figure
        value={`${last()}.${(last() * 7) % 10}`}
        unit="k/s"
        note={`${last() >= avg() ? "+" : "−"}${Math.abs(last() - avg())} vs. average`}
        tone={last() >= avg() ? "up" : "down"}
      />
      <Canvas
        style={{ height: 180 }}
        draw={(cx, { width, height }) => {
          const values = data();
          cx.font = SANS(11);
          const labelW = cx.measureText("100").width;
          const pad = { left: labelW + 8, right: 4, top: 16, bottom: 20 };
          const w = width - pad.left - pad.right;
          const h = height - pad.top - pad.bottom;
          const x = (i: number) => pad.left + (i / (values.length - 1)) * w;
          const y = (v: number) => pad.top + h - (v / 100) * h;
          // Grid and labels.
          cx.textBaseline = "middle";
          for (const v of [0, 50, 100]) {
            dashed(cx, pad.left, y(v), width - pad.right, y(v), colors.line);
            const label = String(v);
            cx.fillStyle = colors.faint;
            cx.fillText(label, pad.left - 8 - cx.measureText(label).width, y(v));
          }
          // The deploy window: hatched.
          const wx = x(9), ww = x(11) - x(9);
          cx.save();
          cx.beginPath();
          cx.rect(wx, pad.top, ww, h);
          cx.clip();
          hatch(cx, wx, pad.top, ww, h, alpha(colors.warn, 0.28), 6);
          cx.restore();
          cx.fillStyle = colors.warn;
          cx.textBaseline = "alphabetic";
          cx.fillText("deploy", wx + 2, pad.top - 4);
          // Day labels.
          cx.fillStyle = colors.faint;
          for (const i of [0, 7, 13]) {
            const label = i === 13 ? "now" : `d-${13 - i}`;
            const lw = cx.measureText(label).width;
            cx.fillText(label, Math.min(width - pad.right - lw, Math.max(pad.left, x(i) - lw / 2)), height - 4);
          }
          // Everything data-driven sweeps in left to right (a native clip).
          cx.save();
          cx.beginPath();
          cx.rect(pad.left - 6, 0, sweep.t.mul(w + 12), height);
          cx.clip();
          const area = cx.createLinearGradient(0, pad.top, 0, pad.top + h);
          area.addColorStop(0, accentA(0.26));
          area.addColorStop(1, accentA(0));
          cx.beginPath();
          cx.moveTo(x(0), y(values[0]));
          values.forEach((v, i) => i > 0 && cx.lineTo(x(i), y(v)));
          cx.lineTo(x(values.length - 1), pad.top + h);
          cx.lineTo(x(0), pad.top + h);
          cx.closePath();
          cx.fillStyle = area;
          cx.fill();
          cx.beginPath();
          values.forEach((v, i) => (i === 0 ? cx.moveTo(x(i), y(v)) : cx.lineTo(x(i), y(v))));
          cx.strokeStyle = colors.accent;
          cx.lineWidth = 2;
          cx.lineJoin = "round";
          cx.stroke();
          values.forEach((v, i) => {
            cx.beginPath();
            cx.arc(x(i), y(v), i === values.length - 1 ? 4.5 : 2.5, 0, TAU);
            cx.fillStyle = colors.inset;
            cx.fill();
            cx.strokeStyle = colors.accent;
            cx.lineWidth = 1.5;
            cx.stroke();
          });
          cx.restore();
          // The average, with a pill label measured to fit.
          const mean = avg();
          dashed(cx, pad.left, y(mean), width - pad.right, y(mean), colors.muted);
          const label = `avg ${mean}`;
          const lw = cx.measureText(label).width + 12;
          cx.fillStyle = colors.raised;
          cx.beginPath();
          cx.roundRect(width - pad.right - lw, y(mean) - 9, lw, 18, 9);
          cx.fill();
          cx.fillStyle = colors.text;
          cx.textBaseline = "middle";
          cx.fillText(label, width - pad.right - lw + 6, y(mean));
        }}
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Legend color={colors.accent} label="Messages" />
        <Legend color={colors.muted} label="Average" />
        <Legend color={colors.warn} label="Deploy" />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A ridgeline: one smooth curve per day, overlapping, each a low-alpha fill.

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ridges = days.map((_, d) => {
  const rand = seeded(100 + d);
  const peaks = [6 + rand() * 4, 12 + rand() * 3, 17 + rand() * 4];
  const weights = [0.5 + rand() * 0.5, 0.4 + rand() * 0.6, 0.3 + rand() * 0.7].map((w) => (d >= 5 ? w * 0.55 : w));
  return Array.from({ length: 25 }, (_, h) => peaks.reduce((s, p, k) => s + weights[k] * Math.exp(-((h - p) ** 2) / 6), 0.04));
});

const ridgePeak = Math.max(...ridges.flat());

/** Each day's hue, around the wheel from the theme's citrus. */
const dayHues = [78, 140, 175, 205, 232, 268, 322];
const dayColor = (d: number, a = 1) => `hsla(${dayHues[d]}, ${isDark() ? 78 : 62}%, ${isDark() ? 68 : 40}%, ${a})`;

function Ridgeline() {
  const sweep = reveal(1400);
  return (
    <Card
      icon="animation"
      title="Footfall by hour"
      subtitle="Ridgeline, one curve a day"
      right={<Button label="Replay" variant="secondary" onPress={sweep.replay} />}
    >
      <Caption label="Gate B, last week" note="Peak 12:00–14:00" />
      <Canvas
        style={{ height: 230 }}
        draw={(cx, { width, height }) => {
          cx.font = SANS(11);
          const left = cx.measureText("Mon").width + 10;
          const bottom = 22;
          const amp = 40;
          const top = amp + 6;
          const step = (height - bottom - top) / (days.length - 1);
          const x = (h: number) => left + (h / 24) * (width - left);
          cx.fillStyle = colors.faint;
          cx.textBaseline = "alphabetic";
          for (const h of [0, 6, 12, 18, 24]) {
            const label = String(h).padStart(2, "0");
            const lw = cx.measureText(label).width;
            cx.fillText(label, Math.min(width - lw, Math.max(left, x(h) - lw / 2)), height - 3);
          }
          cx.save();
          cx.beginPath();
          cx.rect(0, 0, sweep.t.mul(width), height);
          cx.clip();
          ridges.forEach((series, d) => {
            const base = top + d * step;
            const y = (v: number) => base - (v / ridgePeak) * amp;
            // The curve alone: the fill closes it, the line stays open.
            const curve = () => {
              cx.moveTo(x(0), y(series[0]));
              for (let h = 1; h < series.length; h++) {
                const mx = (x(h - 1) + x(h)) / 2;
                cx.quadraticCurveTo(x(h - 1), y(series[h - 1]), mx, (y(series[h - 1]) + y(series[h])) / 2);
              }
              cx.lineTo(x(24), y(series[24]));
            };
            cx.beginPath();
            curve();
            cx.lineTo(x(24), base);
            cx.lineTo(x(0), base);
            cx.closePath();
            // Occlude the ridge behind, then a fill that fades to the baseline.
            cx.fillStyle = colors.inset;
            cx.fill();
            // A short fade below the crests, so the curves stay what reads.
            const fade = cx.createLinearGradient(0, base - amp, 0, base - amp * 0.3);
            fade.addColorStop(0, dayColor(d, 0.34));
            fade.addColorStop(1, dayColor(d, 0));
            cx.fillStyle = fade;
            cx.fill();
            cx.strokeStyle = dayColor(d);
            cx.lineWidth = 1.5;
            cx.lineJoin = "round";
            cx.beginPath();
            curve();
            cx.stroke();
          });
          // The peak window, over the ridges so it reads as one band.
          dashed(cx, x(12), 0, x(12), height - bottom, alpha(colors.muted, 0.35));
          dashed(cx, x(14), 0, x(14), height - bottom, alpha(colors.muted, 0.35));
          cx.restore();
          days.forEach((day, d) => {
            cx.fillStyle = dayColor(d);
            cx.fillText(day, 0, top + d * step - 2);
          });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A dot matrix: uptime per hour block, a pulse on the newest dot (native loop).

/** The dot levels, from none to full (call in a reactive scope). */
const levels = () => [colors.raised, accentA(0.22), accentA(0.45), accentA(0.7), colors.accent];

function DotMatrix() {
  const pulse = createAnimatedValue(0);
  const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad) }));
  loop.start();
  cleanup(() => loop.stop());
  return (
    <Card icon="bell" title="Beacon uptime" subtitle="Dot matrix, one column a day">
      <Figure value="99.94" unit="%" note="3 incidents" tone="danger" />
      <Canvas
        style={{ height: 96 }}
        draw={(cx, { width, height }) => {
          const rows = 7;
          const gap = 12.5;
          const cols = Math.floor(width / gap);
          const ox = (width - (cols - 1) * gap) / 2;
          const oy = (height - (rows - 1) * gap) / 2;
          const rand = seeded(42);
          let lastX = 0, lastY = 0;
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
              const n = rand();
              const incident = (c === 6 && r === 2) || (c === 17 && r === 5) || (c === cols - 4 && r === 3);
              cx.fillStyle = incident ? colors.danger : levels()[Math.min(4, Math.floor(n * n * 5 + (c / cols) * 1.6))];
              cx.beginPath();
              cx.arc(ox + c * gap, oy + r * gap, 3.6, 0, TAU);
              cx.fill();
              lastX = ox + c * gap;
              lastY = oy + r * gap;
            }
          }
          // The pulse: radius and alpha follow a native loop.
          cx.save();
          cx.globalAlpha = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });
          cx.strokeStyle = colors.accent;
          cx.lineWidth = 1.5;
          cx.beginPath();
          cx.arc(lastX, lastY, pulse.interpolate({ inputRange: [0, 1], outputRange: [4, 11] }), 0, TAU);
          cx.stroke();
          cx.restore();
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 13, color: colors.muted }}>Less</Text>
        <Each of={levels()}>{(c) => <View style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: c() }} />}</Each>
        <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>More</Text>
        <Legend color={colors.danger} label="Incident" />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A dumbbell plot: before → after per row, the after dots travel natively
// (one value, staggered through each row's input range).

const routes = [
  { name: "North Gate", before: 182, after: 96 },
  { name: "Harbor", before: 240, after: 131 },
  { name: "Old Mill", before: 128, after: 104 },
  { name: "Ridge", before: 205, after: 88 },
  { name: "Lowfield", before: 96, after: 71 },
  { name: "Quarry", before: 151, after: 160 },
];

function Dumbbell() {
  const t: AnimatedValue = createAnimatedValue(0);
  const play = () => {
    t.set(0);
    t.timing(1, { duration: 1500, easing: Easing.out(Easing.cubic) });
  };
  play();
  return (
    <Card
      icon="physics"
      title="Route latency"
      subtitle="Dumbbell, before → after"
      right={<Button label="Replay" variant="secondary" onPress={play} />}
    >
      <Canvas
        style={{ height: 30 * routes.length + 24 }}
        draw={(cx, { width, height }) => {
          cx.font = SANS(13);
          const left = Math.max(...routes.map((r) => cx.measureText(r.name).width)) + 12;
          cx.font = SANS(11);
          const right = cx.measureText("+00%").width + 10;
          const max = 250;
          const x = (ms: number) => left + (ms / max) * (width - left - right);
          cx.textBaseline = "alphabetic";
          for (const ms of [0, 100, 200]) {
            dashed(cx, x(ms), 0, x(ms), height - 18, colors.line);
            cx.fillStyle = colors.faint;
            const label = `${ms}`;
            cx.fillText(label, x(ms) - cx.measureText(label).width / 2, height - 3);
          }
          routes.forEach((r, i) => {
            const cy = 15 + i * 30;
            const start = i * 0.07;
            const after = t.interpolate({ inputRange: [start, start + 0.6], outputRange: [x(r.before), x(r.after)] });
            const worse = r.after > r.before;
            const tone = worse ? colors.danger : colors.accent;
            cx.font = SANS(13);
            cx.fillStyle = colors.muted;
            cx.textBaseline = "middle";
            cx.fillText(r.name, 0, cy);
            cx.strokeStyle = worse ? alpha(colors.danger, 0.5) : accentA(0.45);
            cx.lineWidth = 3;
            cx.lineCap = "round";
            cx.beginPath();
            cx.moveTo(x(r.before), cy);
            cx.lineTo(after, cy);
            cx.stroke();
            cx.fillStyle = colors.inset;
            cx.strokeStyle = colors.muted;
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.arc(x(r.before), cy, 4.5, 0, TAU);
            cx.fill();
            cx.stroke();
            cx.fillStyle = tone;
            cx.beginPath();
            cx.arc(after, cy, 5.5, 0, TAU);
            cx.fill();
            const pct = Math.round(((r.after - r.before) / r.before) * 100);
            const label = `${pct > 0 ? "+" : ""}${pct}%`;
            cx.font = SANS(11);
            cx.fillStyle = tone;
            cx.fillText(label, width - cx.measureText(label).width, cy);
          });
        }}
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Legend color={colors.muted} label="Before" />
        <Legend color={colors.accent} label="After" />
        <Legend color={colors.danger} label="Regressed" />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A clock: transforms, save / restore, a second hand rotating natively.

function Clock() {
  const seconds = createAnimatedValue(0);
  const loop = Animated.loop(Animated.timing(seconds, { toValue: 60, duration: 60_000, easing: Easing.linear }));
  loop.start();
  cleanup(() => loop.stop());
  return (
    <Card icon="search" title="Transforms" subtitle="translate · rotate · save / restore">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <Canvas
          style={{ width: 150, height: 150 }}
          draw={(cx, { width }) => {
            const r = width / 2;
            cx.translate(r, r);
            cx.fillStyle = colors.surface;
            cx.strokeStyle = colors.border;
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.arc(0, 0, r - 2, 0, TAU);
            cx.fill();
            cx.stroke();
            for (let i = 0; i < 60; i++) {
              cx.save();
              cx.rotate((i / 60) * TAU);
              cx.strokeStyle = i % 5 === 0 ? colors.muted : colors.faint;
              cx.lineWidth = i % 5 === 0 ? 2 : 1;
              cx.beginPath();
              cx.moveTo(r - 8, 0);
              cx.lineTo(r - (i % 5 === 0 ? 17 : 12), 0);
              cx.stroke();
              cx.restore();
            }
            const hand = (angle: number, length: number, w: number) => {
              cx.save();
              cx.rotate(angle - Math.PI / 2);
              cx.strokeStyle = colors.text;
              cx.lineWidth = w;
              cx.lineCap = "round";
              cx.beginPath();
              cx.moveTo(-8, 0);
              cx.lineTo(length, 0);
              cx.stroke();
              cx.restore();
            };
            hand((10 / 12) * TAU, r * 0.48, 4.5);
            hand((10 / 60) * TAU, r * 0.7, 3);
            cx.save();
            cx.rotate(seconds.mul(TAU / 60));
            cx.rotate(-Math.PI / 2);
            cx.strokeStyle = colors.accent;
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.moveTo(-14, 0);
            cx.lineTo(r * 0.8, 0);
            cx.stroke();
            cx.restore();
            cx.fillStyle = colors.accent;
            cx.beginPath();
            cx.arc(0, 0, 4, 0, TAU);
            cx.fill();
          }}
        />
        <View style={{ flex: 1, gap: 8 }}>
          <Caption label="Ticks" note="60 rotations" />
          <Caption label="Hands" note="save, restore" />
          <Caption label="Second hand" note="Native loop" />
        </View>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Path2D: SVG path data, filled or stroked.

/** A glyph's side: a terminal leaves an icon-sized canvas out, so there
 * it is larger, a block of braille dots with no tile around it. */
const GLYPH = terminal ? 64 : 30;

const glyphs: { name: string; d: string; color: keyof Palette; stroke?: boolean }[] = [
  { name: "Heart", d: "M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z", color: "danger" },
  { name: "Star", d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01z", color: "warn" },
  { name: "Bolt", d: "M13 2L3 14h7l-1 8 10-12h-7z", color: "info" },
  { name: "Check", d: "M20 6L9 17l-5-5", color: "accent", stroke: true },
];

function Glyphs() {
  return (
    <Card icon="star" title="Path2D" subtitle="SVG path data, parsed natively">
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Each of={glyphs}>
          {(glyph) => {
            const path = new Path2D(glyph().d);
            return (
              <View style={{ alignItems: "center", gap: 8 }}>
                <View
                  style={
                    terminal
                      ? { alignItems: "center" }
                      : {
                          width: 60,
                          height: 60,
                          borderRadius: 18,
                          borderCurve: "continuous",
                          backgroundColor: colors.raised,
                          ...finish.raised,
                          borderWidth: 1,
                          borderColor: colors.border,
                          alignItems: "center",
                          justifyContent: "center",
                        }
                  }
                >
                  <Canvas
                    style={{ width: GLYPH, height: GLYPH }}
                    draw={(cx) => {
                      cx.scale(GLYPH / 24, GLYPH / 24);
                      if (glyph().stroke) {
                        cx.strokeStyle = colors[glyph().color];
                        cx.lineWidth = 2.5;
                        cx.lineCap = "round";
                        cx.lineJoin = "round";
                        cx.stroke(path);
                      } else {
                        cx.fillStyle = colors[glyph().color];
                        cx.fill(path);
                      }
                    }}
                  />
                </View>
                <Text style={{ fontSize: 13, color: colors.muted }}>{glyph().name}</Text>
              </View>
            );
          }}
        </Each>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Images, clipping, shadows, compositing, dashes, radial gradients.

function Compositing() {
  const label = { flex: 1, fontSize: 13, color: colors.muted, textAlign: "center" } as const;
  return (
    <Card icon="image" title="Compositing" subtitle="Clip, shadow, destination-out, dashes">
      <Canvas
        style={{ height: 132 }}
        draw={(cx, { width, height }) => {
          const cy = height / 2;
          const shadow = isDark() ? "rgba(0,0,0,0.55)" : "rgba(16,20,30,0.2)";
          // An image clipped to a disc: larger than the disc, so the clip shows.
          const c1 = width / 6;
          cx.save();
          cx.shadowColor = shadow;
          cx.shadowBlur = 16;
          cx.shadowOffsetY = 6;
          cx.fillStyle = colors.raised;
          cx.beginPath();
          cx.arc(c1, cy, 40, 0, TAU);
          cx.fill();
          cx.restore();
          cx.save();
          cx.beginPath();
          cx.arc(c1, cy, 40, 0, TAU);
          cx.clip();
          const disc = cx.createLinearGradient(c1 - 40, cy - 40, c1 + 40, cy + 40);
          disc.addColorStop(0, colors.raised);
          disc.addColorStop(1, colors.inset);
          cx.fillStyle = disc;
          cx.fillRect(c1 - 40, cy - 40, 80, 80);
          cx.drawImage(logo, c1 - 46, cy - 46, 92, 92);
          cx.restore();
          cx.strokeStyle = accentA(0.55);
          cx.lineWidth = 1.5;
          cx.beginPath();
          cx.arc(c1, cy, 44, 0, TAU);
          cx.stroke();
          // A ticket with a shadow; its notches and hole are cut out (destination-out).
          const c2 = width / 2;
          cx.save();
          cx.shadowColor = shadow;
          cx.shadowBlur = 16;
          cx.shadowOffsetY = 6;
          const paper = cx.createLinearGradient(c2 - 52, cy - 36, c2 + 52, cy + 36);
          paper.addColorStop(0, colors.accentFill);
          paper.addColorStop(1, "#7fbf3a");
          cx.fillStyle = paper;
          cx.beginPath();
          cx.roundRect(c2 - 52, cy - 36, 104, 72, 14);
          cx.fill();
          cx.restore();
          cx.globalCompositeOperation = "destination-out";
          cx.beginPath();
          cx.arc(c2 + 20, cy - 36, 8, 0, TAU);
          cx.arc(c2 + 20, cy + 36, 8, 0, TAU);
          cx.fill();
          cx.beginPath();
          cx.arc(c2 - 16, cy, 13, 0, TAU);
          cx.fill();
          cx.setLineDash([4, 4]);
          cx.lineWidth = 2;
          cx.beginPath();
          cx.moveTo(c2 + 20, cy - 26);
          cx.lineTo(c2 + 20, cy + 26);
          cx.stroke();
          cx.setLineDash([]);
          cx.globalCompositeOperation = "source-over";
          // A lit sphere in its glow, a dashed orbit and a small moon.
          const c3 = (5 * width) / 6;
          const glow = cx.createRadialGradient(c3, cy, 22, c3, cy, 52);
          glow.addColorStop(0, alpha(colors.warn, 0.32));
          glow.addColorStop(1, alpha(colors.warn, 0));
          cx.fillStyle = glow;
          cx.beginPath();
          cx.arc(c3, cy, 52, 0, TAU);
          cx.fill();
          const lit = cx.createRadialGradient(c3 - 10, cy - 12, 2, c3, cy, 30);
          lit.addColorStop(0, "#fff3d6");
          lit.addColorStop(0.35, "#ffc05c");
          lit.addColorStop(0.75, "#e8743b");
          lit.addColorStop(1, "#a93f2c");
          cx.fillStyle = lit;
          cx.beginPath();
          cx.arc(c3, cy, 30, 0, TAU);
          cx.fill();
          cx.setLineDash([3, 5]);
          cx.strokeStyle = alpha(colors.warn, 0.6);
          cx.lineWidth = 1.25;
          cx.beginPath();
          cx.arc(c3, cy, 42, 0, TAU);
          cx.stroke();
          cx.setLineDash([]);
          cx.fillStyle = "#ffe2a8";
          cx.beginPath();
          cx.arc(c3 + 42 * Math.cos(-0.7), cy + 42 * Math.sin(-0.7), 4, 0, TAU);
          cx.fill();
        }}
      />
      <View style={{ flexDirection: "row" }}>
        <Text style={label}>Clipped image</Text>
        <Text style={label}>Cut-out</Text>
        <Text style={label}>Radial gradient</Text>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Touch drawing: each move draws again from JS.

/** "NSH" as strokes, each point a fraction of a letter's box. */
const SAMPLE: { letter: number; points: [number, number][] }[] = [
  { letter: 0, points: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  {
    letter: 1,
    points: [
      [0.95, 0.16], [0.8, 0.05], [0.55, 0], [0.3, 0.02], [0.1, 0.12], [0.05, 0.26], [0.15, 0.4], [0.4, 0.49],
      [0.7, 0.57], [0.92, 0.7], [0.95, 0.84], [0.8, 0.95], [0.5, 1], [0.22, 0.97], [0.05, 0.84],
    ],
  },
  { letter: 2, points: [[0, 0], [0, 1]] },
  { letter: 2, points: [[1, 0], [1, 1]] },
  { letter: 2, points: [[0, 0.5], [1, 0.5]] },
];
const samplePoints = SAMPLE.reduce((n, s) => n + s.points.length, 0);

function Sketch() {
  const strokes = signal<[number, number][][]>([]);
  const sample = signal(true);
  const point = (e: GestureResponderEvent): [number, number] => [e.locationX, e.locationY];
  return (
    <Card
      icon="gestures"
      title="Sketch"
      subtitle={hint("Touch → draw from JS", "Drag → draw from JS")}
      right={
        <Button
          label="Clear"
          variant="secondary"
          disabled={!sample() && strokes().length === 0}
          onPress={() => {
            sample.set(false);
            strokes.set([]);
          }}
        />
      }
    >
      <Canvas
        style={{ height: 200 }}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          strokes.set([...strokes(), [point(e)]]);
          // Keep the touches: the scroll view around must not take them.
          return true;
        }}
        onResponderTerminationRequest={() => false}
        onResponderMove={(e) => {
          const all = strokes();
          const last = all[all.length - 1];
          strokes.set([...all.slice(0, -1), [...last, point(e)]]);
        }}
        draw={(cx, { width, height }) => {
          // A dot grid to draw on.
          cx.fillStyle = colors.border;
          for (let x = 8; x < width; x += 16) {
            for (let y = 8; y < height; y += 16) cx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
          }
          if (!sample() && strokes().length === 0) {
            cx.font = SANS(14);
            cx.fillStyle = colors.faint;
            cx.textAlign = "center";
            cx.textBaseline = "middle";
            cx.fillText("Draw here", width / 2, height / 2);
          }
          cx.strokeStyle = colors.accent;
          cx.lineWidth = 3;
          cx.lineCap = "round";
          cx.lineJoin = "round";
          if (sample()) {
            const w = 50;
            const h = 72;
            const gap = 24;
            const x0 = (width - (3 * w + 2 * gap)) / 2;
            const y0 = (height - h) / 2;
            for (const s of SAMPLE) {
              const at = ([x, y]: [number, number]): [number, number] => [x0 + s.letter * (w + gap) + x * w, y0 + y * h];
              const pts = s.points.map(at);
              cx.beginPath();
              cx.moveTo(pts[0][0], pts[0][1]);
              // The S is a curve through its points; the rest are straight lines.
              if (pts.length > 4) {
                for (let i = 1; i < pts.length - 1; i++) {
                  cx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
                }
                cx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
              } else {
                for (const [x, y] of pts.slice(1)) cx.lineTo(x, y);
              }
              cx.stroke();
            }
          }
          for (const s of strokes()) {
            cx.beginPath();
            s.forEach(([x, y], i) => (i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y)));
            cx.stroke();
          }
        }}
      />
      <Caption
        label="Strokes"
        note={`${strokes().length + (sample() ? SAMPLE.length : 0)} · ${strokes().reduce((n, s) => n + s.length, 0) + (sample() ? samplePoints : 0)} points`}
      />
    </Card>
  );
}

export function CanvasDemo() {
  const cards = [Dial, AreaChart, Ridgeline, DotMatrix, Dumbbell, Clock, Glyphs, Compositing, Sketch];
  return <DemoPage cards={cards} columns={3} />;
}
