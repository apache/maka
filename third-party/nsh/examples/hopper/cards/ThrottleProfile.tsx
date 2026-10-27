import { Canvas, computed, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { Icon } from "../icons";
import { addPhase, type Bezier, type EasingName, easingLabel, easings, type Phase, phases, selectedPhase, setBezier, setEasing } from "../store";
import { color, mono, radius } from "../theme";
import { Action, Panel, track } from "../ui";

/** The cubic bezier's y at x (Newton's method on x(t)). */
function bezierAt([x1, y1, x2, y2]: Bezier, x: number): number {
  const curve = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = curve(x1, x2, t) - x;
    const d = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
    if (Math.abs(d) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - dx / d));
  }
  return curve(y1, y2, t);
}

/** A spring (stiffness 180, damping 16) from 0 to 1, x in 0…1 of 0.9 s. */
function springAt(x: number): number {
  const w0 = Math.sqrt(180), zeta = 16 / (2 * w0), wd = w0 * Math.sqrt(1 - zeta * zeta), t = x * 0.9;
  return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
}

const ease = (p: Phase, x: number) => (p.easing === "spring" ? springAt(x) : bezierAt(p.bezier, x));

const HEIGHT = 240;
const pad = { left: 20, right: 20, top: 28, bottom: 28 };

type AnimatedValue = ReturnType<typeof createAnimatedValue>;

/**
 * Throttle into the selected phase: the eased curve over a filled area. Drag
 * the two rings (the bezier's control points) to reshape it; a dot replays
 * it on the UI thread during a preview.
 */
function Curve(props: { phase: Phase; onBezier: (b: Bezier) => void; time: AnimatedValue; value: AnimatedValue }) {
  const width = signal(0);
  let handle: 0 | 1 | null = null;
  const box = () => ({ w: width() - pad.left - pad.right, h: HEIGHT - pad.top - pad.bottom });
  return (
    <Canvas
      style={{ height: HEIGHT, borderRadius: 14, backgroundColor: color.inset }}
      onLayout={(e) => width.set(e.size.width)}
      {...track(
        (x, y, first) => {
          const p = props.phase;
          if (p.easing === "spring") return;
          const { w, h } = box();
          const centerX = (x - pad.left) / w, cy = 1 - (y - pad.top) / h;
          if (first) {
            const d = (i: 0 | 1) => Math.hypot((centerX - p.bezier[i * 2]) * w, (cy - p.bezier[i * 2 + 1]) * h);
            handle = d(0) <= d(1) ? 0 : 1;
            if (d(handle) > 44) handle = null;
          }
          if (handle === null) return;
          const next: Bezier = [...p.bezier];
          next[handle * 2] = centerX;
          next[handle * 2 + 1] = Math.min(1.5, Math.max(-0.5, cy));
          props.onBezier(next);
        },
        () => (handle = null),
      )}
      accessibilityLabel={`${props.phase.name}: ${easingLabel(props.phase.easing)} ${props.phase.bezier.join(", ")}`}
      accessibilityHint="Drag the rings to reshape the curve"
      draw={(cx, { width, height }) => {
        const p = props.phase;
        const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
        const X = (x: number) => pad.left + x * w;
        const Y = (y: number) => pad.top + (1 - y) * h;

        cx.strokeStyle = color.grid;
        cx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          cx.beginPath();
          cx.moveTo(pad.left, Y(i / 4));
          cx.lineTo(width - pad.right, Y(i / 4));
          cx.stroke();
        }

        const area = cx.createLinearGradient(0, Y(1), 0, Y(0));
        area.addColorStop(0, "rgba(61,214,198,0.30)");
        area.addColorStop(1, "rgba(61,214,198,0.02)");
        cx.fillStyle = area;
        cx.beginPath();
        cx.moveTo(X(0), Y(0));
        for (let i = 0; i <= 60; i++) cx.lineTo(X(i / 60), Y(ease(p, i / 60)));
        cx.lineTo(X(1), Y(0));
        cx.closePath();
        cx.fill();
        cx.strokeStyle = color.accent;
        cx.lineWidth = 2.5;
        cx.lineJoin = "round";
        cx.beginPath();
        for (let i = 0; i <= 60; i++) {
          if (i === 0) cx.moveTo(X(0), Y(ease(p, 0)));
          else cx.lineTo(X(i / 60), Y(ease(p, i / 60)));
        }
        cx.stroke();

        if (p.easing !== "spring") {
          const [x1, y1, x2, y2] = p.bezier;
          cx.strokeStyle = color.caution;
          cx.lineWidth = 1;
          cx.setLineDash([3, 3]);
          cx.beginPath();
          cx.moveTo(X(0), Y(0));
          cx.lineTo(X(x1), Y(y1));
          cx.moveTo(X(1), Y(1));
          cx.lineTo(X(x2), Y(y2));
          cx.stroke();
          cx.setLineDash([]);
          cx.lineWidth = 2;
          cx.fillStyle = color.inset;
          for (const [x, y] of [[x1, y1], [x2, y2]]) {
            cx.beginPath();
            cx.arc(X(x), Y(y), 7, 0, Math.PI * 2);
            cx.fill();
            cx.stroke();
          }
        }

        cx.fillStyle = color.light;
        cx.beginPath();
        cx.arc(props.time.mul(w).add(pad.left), props.value.mul(-h).add(pad.top + h), 6, 0, Math.PI * 2);
        cx.fill();

        cx.font = `11px ${mono}`;
        cx.fillStyle = color.faint;
        cx.textBaseline = "middle";
        cx.textAlign = "left";
        cx.fillText("100%", pad.left, pad.top - 14);
        cx.textAlign = "right";
        cx.fillText(p.easing === "spring" ? "spring k 180" : `cubic-bezier(${p.bezier.join(", ")})`, width - pad.right, height - 12);
      }}
    />
  );
}

/** The phases on a time axis, spaced by when they start; labels alternate
 * above and below the axis so close phases stay readable. Tap one. */
function Timeline() {
  const width = signal(0);
  const end = computed(() => phases()[phases().length - 1].at || 1);
  const x = (at: number) => 10 + (at / end()) * (width() - 20);
  const label = 72;
  return (
    <View style={{ height: 64 }} onLayout={(e) => width.set(e.size.width)}>
      <View style={{ position: "absolute", left: 10, right: 10, top: 31, height: 2, borderRadius: 1, backgroundColor: color.lineStrong }} />
      <Each of={phases()} key={(p) => p.id}>
        {(phase, i) => {
          const on = () => phase().id === selectedPhase();
          const above = () => i() % 2 === 1;
          const left = () => Math.min(width() - label, Math.max(0, x(phase().at) - label / 2));
          const align = () => (left() === 0 ? "left" : left() === width() - label ? "right" : "center");
          return (
            <View
              onPress={() => selectedPhase.set(phase().id)}
              hitSlop={6}
              role="tab"
              accessibilityLabel={`${phase().name} at ${phase().at} seconds`}
              accessibilityState={{ selected: on() }}
              style={{ position: "absolute", top: 0, bottom: 0, left: left(), width: label }}
            >
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: on() ? 24 : 27,
                  left: x(phase().at) - left() - (on() ? 8 : 5),
                  width: on() ? 16 : 10,
                  height: on() ? 16 : 10,
                  borderRadius: 8,
                  backgroundColor: on() ? color.accent : color.card,
                  borderWidth: 2,
                  borderColor: on() ? color.accent : color.muted,
                }}
              />
              <Text
                pointerEvents="none"
                numberOfLines={1}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: above() ? 2 : 46,
                  textAlign: align(),
                  fontSize: 11,
                  color: on() ? color.text : color.muted,
                }}
              >
                {phase().name}
              </Text>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** The easing choices, dropped under the picker. */
function Choices(props: { value: EasingName; onPick: (e: EasingName) => void }) {
  return (
    <View
      role="menu"
      style={{
        position: "absolute",
        right: 0,
        top: 48,
        width: 210,
        paddingVertical: 6,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: color.lineStrong,
        backgroundColor: color.raised,
        shadowColor: "#000",
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      <Each of={easings}>
        {(option) => (
          <View
            onPress={() => props.onPick(option().name)}
            activeStyle={{ backgroundColor: color.lineStrong }}
            role="menuitem"
            accessibilityState={{ checked: props.value === option().name }}
            style={{ flexDirection: "row", alignItems: "center", height: 40, paddingHorizontal: 14, gap: 8 }}
          >
            <Text style={{ flex: 1, fontSize: 14, color: props.value === option().name ? color.accent : color.text }}>
              {option().label}
            </Text>
            <If when={props.value === option().name}>
              <Icon name="check" size={16} tint={color.accent} />
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

export function ThrottleProfile() {
  const open = signal(false);
  const time = createAnimatedValue(0);
  const value = createAnimatedValue(0);
  const playing = signal(false);

  const index = computed(() => Math.max(0, phases().findIndex((p) => p.id === selectedPhase())));
  const phase = computed(() => phases()[index()]);
  const previous = computed(() => phases()[Math.max(0, index() - 1)]);

  const preview = async () => {
    open.set(false);
    playing.set(true);
    const p = phase();
    // Real time for short phases, at most 2.5 s for long ones.
    const duration = p.easing === "spring" ? 900 : Math.min(2500, Math.max(400, (p.at - previous().at) * 1000));
    time.set(0);
    value.set(0);
    const y = p.easing === "spring" ? value.spring(1, { stiffness: 180, damping: 16 }) : value.timing(1, { duration, easing: Easing.bezier(...p.bezier) });
    await Promise.all([time.timing(1, { duration, easing: Easing.linear }), y]);
    playing.set(false);
  };

  return (
    <Panel
      icon="throttle"
      title="Throttle profile"
      status={`${phases().length} phases · ${phases()[phases().length - 1].at} s burn`}
    >
      <Timeline />
      {/* Over the curve, so the menu hanging below draws and takes taps there. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, zIndex: 1 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 17, fontWeight: "600", color: color.text }}>{phase().name}</Text>
          <Text style={{ fontSize: 13, color: color.muted }}>
            from {previous().name} · <Text style={{ fontFamily: mono }}>T+{phase().at.toFixed(1)} s</Text>
          </Text>
        </View>
        <View
          onPress={() => open.set(!open())}
          role="button"
          accessibilityLabel={`Easing: ${easingLabel(phase().easing)}`}
          accessibilityState={{ expanded: open() }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            height: 40,
            paddingLeft: 14,
            paddingRight: 10,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: open() ? color.accent : color.lineStrong,
          }}
        >
          <Text style={{ fontSize: 14, color: color.text }}>{easingLabel(phase().easing)}</Text>
          <Icon name="caret" size={16} tint={color.muted} flip={open()} />
        </View>
        <If when={open()}>
          <Choices
            value={phase().easing}
            onPick={(e) => {
              setEasing(phase().id, e);
              open.set(false);
            }}
          />
        </If>
      </View>
      <View>
        <Curve phase={phase()} onBezier={(b) => setBezier(phase().id, b)} time={time} value={value} />
        {/* A tap beside the open menu closes it instead of moving a handle. */}
        <If when={open()}>
          <View onPress={() => open.set(false)} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
        </If>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Action label="Add phase" onPress={addPhase} />
        <Action label={playing() ? "Playing…" : "Preview"} primary disabled={playing()} onPress={preview} />
      </View>
    </Panel>
  );
}
