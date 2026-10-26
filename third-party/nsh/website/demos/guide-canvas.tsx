import { Canvas, type GestureResponderEvent, mount, Path2D, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { button, buttonText, Inspector, Panel, tint, ui, wide } from "./palette";

const TAU = Math.PI * 2;
const heart = new Path2D("M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z");

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button()}>
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

function App() {
  // The ring's sweep is an animated value: animating it redraws without running `draw`.
  const progress = createAnimatedValue(0.35);
  const target = signal(0.35);
  const go = () => {
    const to = Math.round(Math.random() * 100) / 100;
    target.set(to);
    progress.timing(to, { duration: 800, easing: Easing.inOut(Easing.cubic) });
  };

  // The chart reads a signal: changing it runs `draw` again.
  const data = signal([12, 30, 22, 48, 36, 60, 52, 75]);

  // Finger drawing through the responder system.
  const strokes = signal<[number, number][][]>([]);
  const point = (e: GestureResponderEvent): [number, number] => [e.locationX, e.locationY];

  const ring = () => (
    <Canvas
      style={{ width: 110, height: 110 }}
      draw={(cx, { width, height }) => {
        const centerX = width / 2;
        const cy = height / 2;
        const r = width / 2 - 8;
        cx.lineWidth = 10;
        cx.lineCap = "round";
        cx.strokeStyle = ui().border;
        cx.beginPath();
        cx.arc(centerX, cy, r, 0, TAU);
        cx.stroke();
        const g = cx.createConicGradient(-Math.PI / 2, centerX, cy);
        g.addColorStop(0, ui().up);
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
  );
  const heartCanvas = () => (
    <Canvas
      style={{ width: 48, height: 48 }}
      draw={(cx) => {
        cx.scale(2, 2);
        cx.shadowColor = tint(ui().down, 0.45);
        cx.shadowBlur = 4;
        cx.fillStyle = ui().down;
        cx.fill(heart);
      }}
    />
  );
  const chart = (height: number) => (
    <Canvas
      style={{ ...ui().inset, height, borderRadius: 12 }}
      draw={(cx, { width, height }) => {
        const values = data();
        const pad = 16;
        const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
        const y = (v: number) => height - pad - (v / 100) * (height - 2 * pad);
        const area = cx.createLinearGradient(0, pad, 0, height - pad);
        area.addColorStop(0, tint(ui().accent, 0.28));
        area.addColorStop(1, tint(ui().accent, 0));
        cx.beginPath();
        values.forEach((v, i) => (i === 0 ? cx.moveTo(x(i), y(v)) : cx.lineTo(x(i), y(v))));
        cx.lineTo(x(values.length - 1), height - pad);
        cx.lineTo(x(0), height - pad);
        cx.closePath();
        cx.fillStyle = area;
        cx.fill();
        cx.beginPath();
        values.forEach((v, i) => (i === 0 ? cx.moveTo(x(i), y(v)) : cx.lineTo(x(i), y(v))));
        cx.strokeStyle = ui().accent;
        cx.lineWidth = 2.5;
        cx.lineJoin = "round";
        cx.stroke();
      }}
    />
  );
  const newData = () => <Button label="New data" onPress={() => data.set(data().map(() => Math.round(10 + Math.random() * 85)))} />;
  const pad = () => (
    <Canvas
      style={{ ...ui().inset, flex: 1, borderRadius: 12 }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        strokes.set([...strokes(), [point(e)]]);
        return true;
      }}
      onResponderMove={(e) => {
        const all = strokes();
        strokes.set([...all.slice(0, -1), [...all[all.length - 1], point(e)]]);
      }}
      draw={(cx, { width }) => {
        cx.fillStyle = ui().faint;
        cx.font = "13px system-ui";
        cx.textAlign = "center";
        cx.fillText("Draw here", width / 2, 20);
        cx.strokeStyle = ui().text;
        cx.lineWidth = 3;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        for (const s of strokes()) {
          cx.beginPath();
          s.forEach(([px, py], i) => (i === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py)));
          cx.stroke();
        }
      }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 16, paddingTop: 24, gap: 14 }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 14 }}>
              {chart(200)}
              {pad()}
            </View>
            <Inspector>
              <Panel title="An animated value in draw">
                <View style={{ gap: 10 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
                    {ring()}
                    {heartCanvas()}
                  </View>
                  <Button label="Animate the ring" onPress={go} />
                </View>
              </Panel>
              <Panel title="A signal in draw">
                <View style={{ gap: 10 }}>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>[{data().join(", ")}]</Text>
                  {newData()}
                </View>
              </Panel>
              <Panel title="Responder events">
                <View style={{ gap: 10 }}>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>
                    {strokes().length} strokes · {strokes().reduce((n, s) => n + s.length, 0)} points
                  </Text>
                  <Button label="Clear" onPress={() => strokes.set([])} />
                </View>
              </Panel>
            </Inspector>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
              {ring()}
              <View style={{ gap: 10 }}>
                <Button label="Animate the ring" onPress={go} />
                {heartCanvas()}
              </View>
            </View>
            {chart(150)}
            {newData()}
            {pad()}
          </>
        )
      }
    </View>
  );
}

mount(App);
