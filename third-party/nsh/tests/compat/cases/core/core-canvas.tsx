// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `Canvas`.
// A headless run paints nothing, so the script checks what JS sees: the
// size `draw` gets, the canvas's layout, and what the kept context answers
// natively from what it recorded (hit tests on `Path2D` paths, its line
// dash, text measures, gradients made); and the operations the platform is
// told to draw (`drawing` steps). Its script checks each.
import { Text, View, signal } from "nsh";
import { Canvas, CanvasGradient, CanvasRenderingContext2D, Path2D } from "nsh";

function App() {
  let kept: CanvasRenderingContext2D | undefined;
  let size = "";
  let draws = 0;
  // Above the diagonal from the top left to the bottom right.
  const triangle = new Path2D("M0 0 L100 0 L100 100 Z");
  const both = new Path2D();
  both.rect(0, 0, 10, 10);
  both.addPath(new Path2D("M50 50 h10 v10 h-10 Z"));
  let gradient: CanvasGradient | undefined;
  const report = signal("Not checked");
  const check = () => {
    const cx = kept!;
    report.set(
      [
        `size ${size}`,
        `canvas ${cx.canvas.width}x${cx.canvas.height}`,
        `drawn ${draws > 0}`,
        `context ${cx instanceof CanvasRenderingContext2D}`,
        `gradient ${gradient instanceof CanvasGradient}`,
        `in ${cx.isPointInPath(triangle, 75, 25)}`,
        `out ${cx.isPointInPath(triangle, 25, 75)}`,
        `added ${cx.isPointInPath(both, 55, 55)}`,
        `current ${cx.isPointInPath(150, 30)}`,
        `stroke ${cx.isPointInStroke(triangle, 50, 1)}`,
        `dash ${cx.getLineDash().join(",")}`,
        `measured ${cx.measureText("Hello").width > 0}`,
      ].join(" "),
    );
  };
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Canvas
        testID="canvas"
        style={{ width: 200, height: 100 }}
        draw={(cx, s) => {
          kept = cx;
          size = `${s.width}x${s.height}`;
          draws++;
          gradient = cx.createLinearGradient(0, 0, 200, 0);
          gradient.addColorStop(0, "red");
          gradient.addColorStop(1, "blue");
          cx.fillStyle = gradient;
          cx.fill(triangle);
          cx.lineWidth = 4;
          cx.setLineDash([4, 2]);
          cx.strokeStyle = "black";
          cx.stroke(triangle);
          cx.setLineDash([]);
          cx.font = "16px sans-serif";
          cx.fillText("Hi", 120, 50);
          cx.beginPath();
          cx.rect(120, 10, 60, 40);
          cx.fill();
          cx.setLineDash([3, 1]);
        }}
      />
      <View testID="check" onPress={check}>
        <Text>Check</Text>
      </View>
      <Text>{report()}</Text>
    </View>
  );
}

export default App;
