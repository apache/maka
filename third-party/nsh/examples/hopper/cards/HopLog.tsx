import { Canvas, computed, signal, Text, View } from "nsh";
import { ago, dispersion, type Hop, hops, now, type Outcome, touchdowns } from "../store";
import { color, mono } from "../theme";
import { Caption, Line, Panel, Pill, track } from "../ui";

const tones: Record<Outcome, "accent" | "caution" | "alert"> = { nominal: "accent", hard: "caution", abort: "alert" };

/** Apogee of the last 40 hops as columns (aborts in rose). Slide across to
 * inspect one. */
function Apogees() {
  const last = computed(() => hops().slice(-40));
  const width = signal(0);
  const picked = signal<number | null>(null);
  const index = () => Math.min(picked() ?? last().length - 1, last().length - 1);
  const hop = () => last()[index()];
  const top = 160;
  return (
    <View style={{ gap: 8 }}>
      <Canvas
        style={{ height: 72 }}
        onLayout={(e) => width.set(e.size.width)}
        {...track((x) => {
          const n = last().length;
          if (width() > 0) picked.set(Math.min(n - 1, Math.max(0, Math.floor((x / width()) * n))));
        })}
        role="adjustable"
        accessibilityLabel="Apogee of the last hops"
        accessibilityValue={{ text: `Hop ${hop().id}, ${Math.round(hop().apogee)} meters, ${hop().outcome}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) =>
          picked.set(Math.min(last().length - 1, Math.max(0, index() + (e.actionName === "increment" ? 1 : -1))))
        }
        draw={(cx, { width, height }) => {
          const all = last();
          const step = width / all.length;
          // The ceiling, dashed.
          cx.strokeStyle = color.lineStrong;
          cx.setLineDash([2, 4]);
          cx.beginPath();
          cx.moveTo(0, height - (150 / top) * height);
          cx.lineTo(width, height - (150 / top) * height);
          cx.stroke();
          cx.setLineDash([]);
          cx.lineCap = "round";
          cx.lineWidth = Math.max(2, step * 0.45);
          all.forEach((h, i) => {
            const x = i * step + step / 2;
            cx.strokeStyle = i === index() ? color.light : h.outcome === "abort" ? color.alert : h.outcome === "hard" ? color.caution : color.bar;
            cx.beginPath();
            cx.moveTo(x, height - 2);
            cx.lineTo(x, height - 2 - Math.max(4, (h.apogee / top) * (height - 6)));
            cx.stroke();
          });
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ numberOfLines: 1, flex: 1, fontSize: 13, color: color.muted }}>
          Hop {hop().id} · <Text style={{ fontFamily: mono, color: color.text }}>{Math.round(hop().apogee)} m</Text> · {hop().note}
        </Text>
        <If when={picked() !== null}>
          <Text onPress={() => picked.set(null)} hitSlop={8} role="button" style={{ fontSize: 13, color: color.accent }}>
            Latest
          </Text>
        </If>
      </View>
    </View>
  );
}

/**
 * Touchdowns seen from above, rings every meter. The dashed circle is the
 * landing zone: drag on the plot to resize it; points inside it are teal.
 */
function Dispersion() {
  const size = signal(0);
  const zone = signal(1.5);
  const reach = 3.5;
  const inside = computed(() => {
    const all = touchdowns();
    return Math.round((all.filter((p) => Math.hypot(p.x, p.y) <= zone()).length / all.length) * 100);
  });
  return (
    <View style={{ gap: 8 }}>
      <Canvas
        style={{ aspectRatio: 1.25, borderRadius: 14, backgroundColor: color.inset }}
        onLayout={(e) => size.set(Math.min(e.size.width, e.size.width / 1.25))}
        {...track((x, y) => {
          const s = size();
          if (s <= 0) return;
          const scale = s / 2 / reach;
          const r = Math.hypot(x - (s * 1.25) / 2, y - s / 2) / scale;
          zone.set(Math.round(Math.min(3, Math.max(0.3, r)) * 10) / 10);
        })}
        role="adjustable"
        accessibilityLabel="Touchdown dispersion and landing zone"
        accessibilityValue={{ text: `zone ${zone().toFixed(1)} meters, ${inside()} percent inside` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) =>
          zone.set(Math.round(Math.min(3, Math.max(0.3, zone() + (e.actionName === "increment" ? 0.1 : -0.1))) * 10) / 10)
        }
        draw={(cx, { width, height }) => {
          const centerX = width / 2, cy = height / 2;
          const scale = height / 2 / reach;
          cx.strokeStyle = color.grid;
          cx.lineWidth = 1;
          for (let r = 1; r <= 3; r++) {
            cx.beginPath();
            cx.arc(centerX, cy, r * scale, 0, Math.PI * 2);
            cx.stroke();
          }
          cx.beginPath();
          cx.moveTo(0, cy);
          cx.lineTo(width, cy);
          cx.moveTo(centerX, 0);
          cx.lineTo(centerX, height);
          cx.stroke();
          cx.fillStyle = color.faint;
          cx.font = `11px ${mono}`;
          cx.textAlign = "left";
          cx.textBaseline = "bottom";
          for (let r = 1; r <= 3; r++) cx.fillText(`${r} m`, centerX + r * scale + 3, cy - 3);

          cx.fillStyle = color.accentDim;
          cx.beginPath();
          cx.arc(centerX, cy, zone() * scale, 0, Math.PI * 2);
          cx.fill();
          cx.strokeStyle = color.accent;
          cx.setLineDash([5, 4]);
          cx.stroke();
          cx.setLineDash([]);

          for (const p of touchdowns()) {
            const d = Math.hypot(p.x, p.y);
            cx.fillStyle = d <= zone() ? color.accent : d > 2.5 ? color.alert : color.muted;
            cx.beginPath();
            cx.arc(centerX + p.x * scale, cy - p.y * scale, 2.6, 0, Math.PI * 2);
            cx.fill();
          }
          // The pad's center.
          cx.strokeStyle = color.light;
          cx.lineWidth = 1.5;
          cx.strokeRect(centerX - 4, cy - 4, 8, 8);
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontFamily: mono, fontSize: 13, color: color.accent }}>zone {zone().toFixed(1)} m</Text>
        <Text style={{ fontFamily: mono, fontSize: 13, color: color.muted }}>{inside()}% inside</Text>
      </View>
    </View>
  );
}

export function HopLog(props: { onOpen?: () => void; rows?: number }) {
  const recent = computed(() => hops().slice(-(props.rows ?? 3)).reverse());
  const issues = computed(() => hops().slice(-40).filter((h) => h.outcome !== "nominal").length);
  return (
    <Panel
      icon="hops"
      title="Hop tests"
      onOpen={props.onOpen}
      status={
        <Text>
          {hops().length} flown · <Text style={{ color: issues() > 0 ? color.caution : color.accent }}>{issues()} off-nominal</Text> in the last 40
        </Text>
      }
    >
      <Apogees />
      <View>
        <Each of={recent()} key={(h) => h.id}>
          {(hop, i) => (
            <Line first={i() === 0}>
              <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
                <Text style={{ fontSize: 15, color: color.text }}>Hop {hop().id}</Text>
                <Text style={{ fontSize: 13, color: color.muted }}>
                  {hop().note} · {ago(hop().at, now())}
                </Text>
              </View>
              <Text style={{ fontFamily: mono, fontSize: 14, color: color.text }}>{Math.round(hop().apogee)} m</Text>
              <Pill label={hop().outcome} tone={tones[hop().outcome]} width={78} />
            </Line>
          )}
        </Each>
      </View>
      <Caption label="Touchdown dispersion" value={`rms ${dispersion().toFixed(2)} m`} />
      <Dispersion />
    </Panel>
  );
}
