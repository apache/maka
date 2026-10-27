// A case of the API's test suite (docs/dev/compatibility.md): what an image
// shows, as the platform receives it: its source (a URL, then another), how
// it fits its box (the `objectFit` style: `none` at its natural size,
// `scale-down` shrunk to fit, as the `object-*` classes say, a style's value
// over a class's), the placeholder until it loads, a blur and how long it
// fades in. Its script checks each.
import { Text, View, signal } from "nsh";
import { Image } from "nsh";

function App() {
  const photo = signal("https://example.com/a.png");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="next" onPress={() => photo.set("https://example.com/b.png")}>
        <Text>Next</Text>
      </View>
      <Image
        testID="photo"
        src={photo()}
        placeholder="https://example.com/placeholder.png"
        blurRadius={6}
        fadeDuration={150}
        style={{ width: 120, height: 80, objectFit: "contain" }}
      />
      <Image testID="plain" src="https://example.com/plain.png" style={{ width: 40, height: 40 }} />
      <Image testID="scale-down" src="https://example.com/plain.png" style={{ width: 40, height: 40, objectFit: "scale-down" }} />
      <Image testID="object-none" src="https://example.com/plain.png" class="object-none" style={{ width: 40, height: 40 }} />
      <Image testID="object-scale-down" src="https://example.com/plain.png" class="object-scale-down" style={{ width: 40, height: 40 }} />
      <Image testID="fit-fill" src="https://example.com/plain.png" style={{ width: 40, height: 40, objectFit: "fill" }} />
      <Image testID="fit-none" src="https://example.com/plain.png" style={{ width: 40, height: 40, objectFit: "none" }} />
      <Image testID="style-over-class" src="https://example.com/plain.png" class="object-contain" style={{ width: 40, height: 40, objectFit: "cover" }} />
    </View>
  );
}

export default App;
