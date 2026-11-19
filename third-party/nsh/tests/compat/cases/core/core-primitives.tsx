// A case of the API's test suite (docs/dev/compatibility.md): every
// primitive imported from `nsh` (`Image`, `List`, `Canvas` and its classes,
// `WebView`, `Video`), each laid out where its style puts it, `Image`
// carrying its functions and the canvas's classes the values its context
// is made of. Its script checks each.
import { Canvas, CanvasGradient, CanvasRenderingContext2D, Image, List, Path2D, Text, Video, View, WebView, signal } from "nsh";

function App() {
  let kept: CanvasRenderingContext2D | undefined;
  let gradient: CanvasGradient | undefined;
  const square = new Path2D("M0 0 h50 v50 h-50 Z");
  const report = signal("Not checked");
  // A complete 3x2 PNG: the web runtime decodes it in the browser.
  const png = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 157, 116,
    102, 26, 0, 0, 0, 16, 73, 68, 65, 84, 120, 218, 99, 96, 96, 96, 248, 143, 132, 17, 28, 0, 68, 213, 5, 251, 151,
    11, 223, 30, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const blobUrl = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  const check = async () => {
    const cx = kept!;
    const blob = await Image.getSize(blobUrl).then(
      (size) => `${size.width}x${size.height}`,
      () => "failed",
    );
    report.set(
      [
        `functions ${typeof Image.getSize === "function" && typeof Image.prefetch === "function"}`,
        `context ${cx instanceof CanvasRenderingContext2D}`,
        `gradient ${gradient instanceof CanvasGradient}`,
        `path ${cx.isPointInPath(square, 25, 25)}`,
        `blob ${blob}`,
      ].join(" "),
    );
  };
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Image testID="image" src="https://example.com/compat.png" style={{ width: 64, height: 48 }} />
      <Video testID="video" src="https://example.com/compat.mp4" paused style={{ width: 160, height: 90 }} />
      <WebView testID="web" html="<p>compat</p>" style={{ width: 180, height: 60 }} />
      <Canvas
        testID="canvas"
        style={{ width: 100, height: 50 }}
        draw={(cx) => {
          kept = cx;
          gradient = cx.createLinearGradient(0, 0, 100, 0);
          gradient.addColorStop(0, "red");
          gradient.addColorStop(1, "blue");
          cx.fillStyle = gradient;
          cx.fill(square);
        }}
      />
      <List testID="list" each={["Fig", "Kiwi"]} style={{ height: 80 }}>
        {(item, index) => (
          <View testID={`fruit-${index()}`} style={{ height: 30 }}>
            <Text>Fruit {item()}</Text>
          </View>
        )}
      </List>
      <View testID="check" onPress={check}>
        <Text>Check</Text>
      </View>
      <Text>{report()}</Text>
    </View>
  );
}

export default App;
