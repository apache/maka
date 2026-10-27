import { Canvas, mount, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";
import { platform, windowSize } from "nsh";
import { button, buttonText, tint, ui } from "./palette";

const TAU = Math.PI * 2;

// Twelve months of made-up values, 0–100.
const values = [32, 41, 38, 52, 47, 63, 58, 71, 66, 80, 74, 88];
const months = "JFMAMJJASOND";

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} {...button()}>
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

function App() {
  // The month under the finger or pointer: `draw` reads it, so moving redraws.
  const picked = signal(values.length - 1);
  const pick = (x: number, width: number) =>
    picked.set(Math.max(0, Math.min(values.length - 1, Math.round(((x - 20) / (width - 40)) * (values.length - 1)))));
  let chartWidth = 0;

  // The dial's angle is a native animated value: it turns without running `draw`.
  const angle = createAnimatedValue(0);
  const turns = signal(0);
  const spin = () => {
    turns.update((n) => n + 1);
    angle.timing(turns() * TAU, { duration: 900, easing: Easing.out(Easing.cubic) });
  };

  const wide = () => windowSize().width >= 700;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>canvas</Text>
      <Text style={{ color: ui().muted }}>
        {platform.idiom === "desktop" ? "Drag across the chart with the mouse" : "Drag your finger across the chart"} · {months[picked()]}{" "}
        = {values[picked()]}
      </Text>

      <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 14 }}>
        <Canvas
          style={{ ...ui().inset, flex: 1, minHeight: 200, borderRadius: 14 }}
          onLayout={(e) => (chartWidth = e.size.width)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => {
            pick(e.locationX, chartWidth);
            return true;
          }}
          onResponderMove={(e) => pick(e.locationX, chartWidth)}
          draw={(cx, { width, height }) => {
            const pad = 20;
            const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
            const y = (v: number) => height - pad - 16 - (v / 100) * (height - 2 * pad - 32);
            const line = () => {
              cx.beginPath();
              values.forEach((v, i) => (i === 0 ? cx.moveTo(x(i), y(v)) : cx.lineTo(x(i), y(v))));
            };

            // Grid lines, dashed.
            cx.strokeStyle = ui().border;
            cx.lineWidth = 1;
            cx.setLineDash([4, 4]);
            for (const v of [25, 50, 75]) {
              cx.beginPath();
              cx.moveTo(pad, y(v));
              cx.lineTo(width - pad, y(v));
              cx.stroke();
            }
            cx.setLineDash([]);

            // The area under the line: a path filled with a linear gradient.
            const area = cx.createLinearGradient(0, pad, 0, height - pad);
            area.addColorStop(0, tint(ui().accent, 0.32));
            area.addColorStop(1, tint(ui().accent, 0));
            line();
            cx.lineTo(x(values.length - 1), y(0));
            cx.lineTo(x(0), y(0));
            cx.closePath();
            cx.fillStyle = area;
            cx.fill();

            line();
            cx.strokeStyle = ui().accent;
            cx.lineWidth = 2.5;
            cx.lineJoin = "round";
            cx.stroke();

            // Month labels: text.
            cx.font = "11px system-ui";
            cx.textAlign = "center";
            cx.textBaseline = "alphabetic";
            values.forEach((_, i) => {
              cx.fillStyle = i === picked() ? ui().text : ui().faint;
              cx.fillText(months[i], x(i), height - 10);
            });

            // The picked point, its guide and a bubble with its value.
            const i = picked();
            const px = x(i);
            const py = y(values[i]);
            cx.strokeStyle = tint(ui().text, 0.25);
            cx.beginPath();
            cx.moveTo(px, pad);
            cx.lineTo(px, y(0));
            cx.stroke();
            cx.shadowColor = tint(ui().accent, 0.6);
            cx.shadowBlur = 10;
            cx.fillStyle = ui().accent;
            cx.beginPath();
            cx.arc(px, py, 6, 0, TAU);
            cx.fill();
            cx.shadowBlur = 0;
            const label = String(values[i]);
            cx.font = "600 13px system-ui";
            const w = cx.measureText(label).width + 16;
            const bx = Math.max(pad, Math.min(width - pad - w, px - w / 2));
            cx.fillStyle = ui().text;
            cx.beginPath();
            cx.roundRect(bx, py - 36, w, 22, 6);
            cx.fill();
            cx.fillStyle = ui().page;
            cx.textBaseline = "middle";
            cx.fillText(label, bx + w / 2, py - 25);
          }}
        />

        <View style={{ ...ui().card, borderRadius: 14, padding: 16, gap: 12, alignItems: "center", width: wide() ? 240 : undefined, alignSelf: wide() ? "flex-start" : undefined }}>
          <Canvas
            style={{ width: 120, height: 120 }}
            draw={(cx, { width, height }) => {
              const r = width / 2 - 6;
              const c = cx.createConicGradient(0, width / 2, height / 2);
              c.addColorStop(0, ui().info);
              c.addColorStop(0.5, ui().violet);
              c.addColorStop(1, ui().info);
              cx.fillStyle = c;
              cx.beginPath();
              cx.arc(width / 2, height / 2, r, 0, TAU);
              cx.fill();
              cx.translate(width / 2, height / 2);
              cx.rotate(angle); // animates natively
              cx.fillStyle = ui().page;
              cx.beginPath();
              cx.moveTo(0, -r + 10);
              cx.lineTo(8, 0);
              cx.lineTo(-8, 0);
              cx.closePath();
              cx.fill();
              cx.beginPath();
              cx.arc(0, 0, 10, 0, TAU);
              cx.fill();
            }}
          />
          <Text style={{ color: ui().muted, textAlign: "center" }}>Turns: {turns()} (a native animated value)</Text>
          <Button label="Spin" onPress={spin} />
        </View>
      </View>
    </View>
  );
}

mount(App);
