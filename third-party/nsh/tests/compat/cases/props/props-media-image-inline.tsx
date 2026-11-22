// A case of the API's test suite (docs/dev/compatibility.md): images whose
// bytes the app already has. A `data:` URI (base64, and percent-encoded as
// a placeholder) and a `blob:` URL of `URL.createObjectURL` show their
// bytes. A chat shows a picked photo from its blob until the upload
// finishes, then switches `src` to the remote URL and revokes the blob's.
import { Image, View, signal } from "nsh";

// A 1 × 1 PNG.
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21,
  196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 252, 207, 192, 240, 31, 0, 5, 5, 2, 0, 95, 200, 241,
  210, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const DATA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='3'/%3E";

function App() {
  const preview = URL.createObjectURL(new Blob([PNG], { type: "image/png" }));
  const src = signal(preview);
  const uploaded = () => {
    src.set("https://example.com/photo.png");
    URL.revokeObjectURL(preview);
  };
  return (
    <View style={{ flex: 1, paddingTop: 64, alignItems: "flex-start" }}>
      <Image testID="data" src={DATA} placeholder={SVG} style={{ width: 40, height: 30 }} />
      <Image testID="preview" src={src()} style={{ width: 40, height: 30 }} />
      <View testID="uploaded" onPress={uploaded} style={{ width: 40, height: 40 }} />
    </View>
  );
}

export default App;
