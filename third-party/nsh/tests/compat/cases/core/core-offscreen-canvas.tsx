// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `OffscreenCanvas`. The headless backend renders no offscreen canvases,
// so the script checks what JS sees: the canvas's size, its one 2D context
// (`null` for other kinds), text measured from what it recorded, and
// `convertToBlob` with its options rejecting with the `code`
// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, as on every platform without
// offscreen renders.
import { OffscreenCanvas, Text, View, signal } from "nsh";

function App() {
  const shown = signal("Not rendered");
  const canvas = new OffscreenCanvas(120, 80);
  const cx = canvas.getContext("2d");
  const same = canvas.getContext("2d") === cx;
  const other = canvas.getContext("webgl") === null;
  cx.fillStyle = "#0f172a";
  cx.fillRect(0, 0, 120, 80);
  cx.font = "16px sans-serif";
  cx.fillText("Hi", 10, 40);
  const measured = cx.measureText("Hi").width > 0;
  canvas
    .convertToBlob({ type: "image/png", scale: 2 })
    .then((blob) => shown.set(`Rendered ${blob.type}`))
    .catch((e) => shown.set(`Render failed ${e.code ?? "none"}`));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Offscreen ${canvas.width}x${canvas.height}`}</Text>
      <Text>{`Context kept ${same}, other kinds null ${other}`}</Text>
      <Text>{`Measured ${measured}`}</Text>
      <Text>{shown()}</Text>
    </View>
  );
}

export default App;
