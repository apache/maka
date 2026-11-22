import { Canvas, computed, signal, Text, View } from "nsh";
import { gimbalCommands, HOP_LENGTH, tiltAt, tiltLimit } from "../store";
import { color, mono } from "../theme";
import { Caption, Panel, track } from "../ui";

const samples = Array.from({ length: HOP_LENGTH * 20 + 1 }, (_, i) => ({ t: i / 20, deg: tiltAt(i / 20) }));
const peak = samples.reduce((a, s) => (Math.abs(s.deg) > Math.abs(a.deg) ? s : a));
const RANGE = 7;

/**
 * Tilt over the hop inside the ±5° band; excursions past it are rose. Drag
 * across the chart to read the tilt at any moment.
 */
function Chart(props: { cursor: number; onScrub: (t: number) => void }) {
  const width = signal(0);
  const pad = { left: 34, right: 8, top: 12, bottom: 22 };
  return (
    <Canvas
      style={{ height: 210 }}
      onLayout={(e) => width.set(e.bounds.size.width)}
      {...track((x) => {
        const w = width() - pad.left - pad.right;
        if (w > 0) props.onScrub(Math.round(Math.min(HOP_LENGTH, Math.max(0, ((x - pad.left) / w) * HOP_LENGTH)) * 10) / 10);
      })}
      role="adjustable"
      accessibilityLabel="Tilt during the hop"
      accessibilityValue={{ text: `${tiltAt(props.cursor).toFixed(1)} degrees at ${props.cursor.toFixed(1)} seconds` }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) =>
        props.onScrub(Math.min(HOP_LENGTH, Math.max(0, props.cursor + (e.actionName === "increment" ? 0.5 : -0.5))))
      }
      draw={(cx, { width, height }) => {
        const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
        const X = (t: number) => pad.left + (t / HOP_LENGTH) * w;
        const Y = (d: number) => pad.top + ((RANGE - d) / (2 * RANGE)) * h;

        cx.fillStyle = "rgba(61,214,198,0.06)";
        cx.fillRect(pad.left, Y(tiltLimit), w, Y(-tiltLimit) - Y(tiltLimit));
        cx.strokeStyle = color.lineStrong;
        cx.lineWidth = 1;
        cx.setLineDash([4, 4]);
        for (const d of [tiltLimit, -tiltLimit]) {
          cx.beginPath();
          cx.moveTo(pad.left, Y(d));
          cx.lineTo(width - pad.right, Y(d));
          cx.stroke();
        }
        cx.setLineDash([]);
        cx.strokeStyle = color.grid;
        cx.beginPath();
        cx.moveTo(pad.left, Y(0));
        cx.lineTo(width - pad.right, Y(0));
        cx.stroke();

        cx.font = `11px ${mono}`;
        cx.fillStyle = color.faint;
        cx.textBaseline = "middle";
        cx.textAlign = "right";
        for (const d of [tiltLimit, 0, -tiltLimit]) cx.fillText(`${d > 0 ? "+" : ""}${d}°`, pad.left - 6, Y(d));
        cx.textAlign = "center";
        cx.textBaseline = "top";
        for (const t of [0, 6, 12, 18, 24]) cx.fillText(`${t}s`, X(t), height - pad.bottom + 6);

        // The trace, rose where it leaves the band.
        cx.lineWidth = 2;
        cx.lineJoin = "round";
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1], b = samples[i];
          cx.strokeStyle = Math.abs(b.deg) > tiltLimit ? color.alert : color.accent;
          cx.beginPath();
          cx.moveTo(X(a.t), Y(a.deg));
          cx.lineTo(X(b.t), Y(b.deg));
          cx.stroke();
        }

        // The cursor.
        const deg = tiltAt(props.cursor);
        cx.strokeStyle = color.light;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(X(props.cursor), pad.top);
        cx.lineTo(X(props.cursor), pad.top + h);
        cx.stroke();
        cx.fillStyle = color.ink;
        cx.strokeStyle = Math.abs(deg) > tiltLimit ? color.alert : color.light;
        cx.lineWidth = 2;
        cx.beginPath();
        cx.arc(X(props.cursor), Y(deg), 5, 0, Math.PI * 2);
        cx.fill();
        cx.stroke();
      }}
    />
  );
}

/** Gimbal deflection, one bar per half second; slide across to read one. */
function Commands(props: { picked: number | null; onPick: (i: number | null) => void }) {
  const width = signal(0);
  return (
    <Canvas
      style={{ height: 40 }}
      onLayout={(e) => width.set(e.bounds.size.width)}
      {...track(
        (x) => width() > 0 && props.onPick(Math.min(gimbalCommands.length - 1, Math.max(0, Math.floor((x / width()) * gimbalCommands.length)))),
        () => props.onPick(null),
      )}
      accessibilityLabel={`${gimbalCommands.length} gimbal commands`}
      draw={(cx, { width, height }) => {
        const step = width / gimbalCommands.length;
        gimbalCommands.forEach((v, i) => {
          const h = Math.max(3, v * height);
          cx.fillStyle = props.picked === i ? color.light : v > 0.8 ? color.caution : color.bar;
          cx.beginPath();
          cx.roundRect(i * step + 1, (height - h) / 2, step - 2, h, 2);
          cx.fill();
        });
      }}
    />
  );
}

export function Tilt() {
  const cursor = signal(peak.t);
  const picked = signal<number | null>(null);
  const excursions = computed(() => {
    let n = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].deg) > tiltLimit && Math.abs(samples[i - 1].deg) <= tiltLimit) n++;
    return n;
  });
  const commandText = () => {
    const i = picked();
    if (i === null) return "48 × 0.5 s";
    return `${(i / 2).toFixed(1)} s · ${Math.round(gimbalCommands[i] * 100)}%`;
  };
  return (
    <Panel icon="tilt" title="Tilt" status={`Hop 40 replay · 0–${HOP_LENGTH} s`}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 16 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 12, color: color.muted, textTransform: "uppercase", letterSpacing: 0.6 }}>at cursor</Text>
          <Text style={{ fontSize: 30, fontWeight: "600", color: Math.abs(tiltAt(cursor())) > tiltLimit ? color.alert : color.text }}>
            {tiltAt(cursor()) >= 0 ? "+" : ""}
            {tiltAt(cursor()).toFixed(1)}°
            <Text style={{ fontSize: 15, fontWeight: "400", color: color.muted }}> T+{cursor().toFixed(1)} s</Text>
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Text style={{ fontFamily: mono, fontSize: 13, color: color.alert }}>peak {peak.deg.toFixed(1)}°</Text>
          <Text style={{ fontSize: 12, color: color.muted }}>
            {excursions()} excursion{excursions() === 1 ? "" : "s"} past ±{tiltLimit}°
          </Text>
        </View>
      </View>
      <Chart cursor={cursor()} onScrub={(t) => cursor.set(t)} />
      <Caption label="Gimbal commands" value={commandText()} />
      <Commands picked={picked()} onPick={(i) => picked.set(i)} />
    </Panel>
  );
}
