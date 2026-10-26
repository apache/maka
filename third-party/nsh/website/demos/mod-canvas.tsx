import { Canvas, mount, Path2D, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { button, buttonText, Panel, Split, tint, ui, wide } from "./palette";

const TAU = Math.PI * 2;
const heart = new Path2D("M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z");

function Chip(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button()}>
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

function App() {
  const data = signal([12, 30, 22, 48, 36, 60, 52, 75, 64, 88]);
  const progress = createAnimatedValue(0.3);
  const target = signal(0.3);
  const go = () => {
    const to = Math.round(Math.random() * 100) / 100;
    target.set(to);
    progress.timing(to, { duration: 900, easing: Easing.inOut(Easing.cubic) });
  };

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>Canvas</Text>
      <Split
        gap={16}
        width={560}
        inspector={
          wide() ? (
            <>
              <Panel title="draw reads a signal">
                <View style={{ gap: 10 }}>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>[{data().join(", ")}]</Text>
                  <Chip label="New point" onPress={() => data.update((v) => [...v.slice(1), Math.round(Math.random() * 90) + 5])} />
                </View>
              </Panel>
              <Panel title="An animated value in draw">
                <View style={{ gap: 10 }}>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>{Math.round(target() * 100)}%</Text>
                  <Chip label="Animate ring" onPress={go} />
                </View>
              </Panel>
            </>
          ) : (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Chip label="New point" onPress={() => data.update((v) => [...v.slice(1), Math.round(Math.random() * 90) + 5])} />
              <Chip label="Animate ring" onPress={go} />
            </View>
          )
        }
      >
      <Canvas
        style={{ height: 170, borderRadius: 12, ...ui().inset }}
        draw={(cx, { width, height }) => {
          const values = data();
          const pad = 16;
          const w = width - pad * 2, h = height - pad * 2;
          const x = (i: number) => pad + (i / (values.length - 1)) * w;
          const y = (v: number) => pad + h - (v / 100) * h;
          const area = cx.createLinearGradient(0, pad, 0, pad + h);
          area.addColorStop(0, tint(ui().accent, 0.28));
          area.addColorStop(1, tint(ui().accent, 0));
          cx.beginPath();
          cx.moveTo(x(0), pad + h);
          values.forEach((v, i) => cx.lineTo(x(i), y(v)));
          cx.lineTo(x(values.length - 1), pad + h);
          cx.closePath();
          cx.fillStyle = area;
          cx.fill();
          cx.beginPath();
          values.forEach((v, i) => (i ? cx.lineTo(x(i), y(v)) : cx.moveTo(x(i), y(v))));
          cx.strokeStyle = ui().accent;
          cx.lineWidth = 2.5;
          cx.lineJoin = "round";
          cx.stroke();
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <Canvas
          style={{ width: 110, height: 110 }}
          draw={(cx, { width, height }) => {
            const centerX = width / 2, cy = height / 2, r = width / 2 - 10;
            cx.lineWidth = 12;
            cx.lineCap = "round";
            cx.strokeStyle = ui().inset.backgroundColor;
            cx.beginPath();
            cx.arc(centerX, cy, r, 0, TAU);
            cx.stroke();
            const g = cx.createConicGradient(-Math.PI / 2, centerX, cy);
            g.addColorStop(0, ui().info);
            g.addColorStop(1, ui().accent);
            cx.strokeStyle = g;
            cx.beginPath();
            cx.arc(centerX, cy, r, -Math.PI / 2, progress.mul(TAU).sub(Math.PI / 2));
            cx.stroke();
            cx.fillStyle = ui().text;
            cx.font = "600 18px system-ui";
            cx.textAlign = "center";
            cx.textBaseline = "middle";
            cx.fillText(`${Math.round(target() * 100)}%`, centerX, cy);
          }}
        />
        <Canvas
          style={{ width: 96, height: 96 }}
          draw={(cx) => {
            cx.save();
            cx.scale(4, 4);
            cx.fillStyle = ui().down;
            cx.fill(heart);
            cx.restore();
          }}
        />
      </View>
      </Split>
    </View>
  );
}

mount(App);
