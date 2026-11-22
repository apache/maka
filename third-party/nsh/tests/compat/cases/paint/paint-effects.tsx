// A case of the API's test suite (docs/dev/compatibility.md): the effect
// keys as the platform receives them: gradients of each kind as the
// background image (React Native's name too), every filter function,
// backdrop filters and every blend mode.
import { Text, View, signal } from "nsh";

const BLENDS = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-darker",
  "plus-lighter",
] as const;

function App() {
  const material = signal<"regular" | "chrome" | undefined>("regular");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Effects</Text>
      <View testID="linear" style={{ height: 4, backgroundImage: "linear-gradient(red, blue)" }} />
      <View testID="linear-angle" style={{ height: 4, backgroundImage: "linear-gradient(45deg, #f00 0%, #00f 100%)" }} />
      <View testID="linear-to" style={{ height: 4, backgroundImage: "linear-gradient(to right, red, green 40%, blue)" }} />
      <View testID="linear-corner" style={{ height: 4, backgroundImage: "linear-gradient(to bottom right, white, black)" }} />
      <View testID="radial" style={{ height: 4, backgroundImage: "radial-gradient(red, blue)" }} />
      <View testID="radial-circle" style={{ height: 4, backgroundImage: "radial-gradient(circle at top left, red, blue)" }} />
      <View testID="radial-size" style={{ height: 4, backgroundImage: "radial-gradient(closest-side, red 20%, blue)" }} />
      <View testID="conic" style={{ height: 4, backgroundImage: "conic-gradient(red, blue)" }} />
      <View testID="conic-from" style={{ height: 4, backgroundImage: "conic-gradient(from 90deg at 25% 75%, red, blue)" }} />
      <View testID="repeating" style={{ height: 4, backgroundImage: "repeating-linear-gradient(90deg, red 0%, blue 10%)" }} />
      <View
        testID="layers"
        style={{ height: 4, backgroundImage: "linear-gradient(red, blue), radial-gradient(white, black)" }}
      />
      <View testID="over-color" style={{ height: 4, backgroundColor: "#ffffff", backgroundImage: "linear-gradient(#0000, #000)" }} />
      <View testID="brightness" style={{ height: 4, filter: "brightness(1.5)" }} />
      <View testID="contrast" style={{ height: 4, filter: "contrast(200%)" }} />
      <View testID="grayscale" style={{ height: 4, filter: "grayscale(1)" }} />
      <View testID="hue-rotate" style={{ height: 4, filter: "hue-rotate(90deg)" }} />
      <View testID="invert" style={{ height: 4, filter: "invert(0.5)" }} />
      <View testID="saturate" style={{ height: 4, filter: "saturate(2)" }} />
      <View testID="sepia" style={{ height: 4, filter: "sepia(100%)" }} />
      <View testID="opacity" style={{ height: 4, filter: "opacity(0.25)" }} />
      <View testID="blur" style={{ height: 4, filter: "blur(4px)" }} />
      <View testID="drop-shadow" style={{ height: 4, filter: "drop-shadow(2px 2px 4px red)" }} />
      <View testID="filters" style={{ height: 4, filter: "grayscale(0.5) blur(2px) brightness(0.8)" }} />
      <View testID="no-filter" style={{ height: 4, filter: "none" }} />
      <View testID="backdrop" style={{ height: 4, backdropFilter: "blur(10px)" }} />
      <View testID="backdrops" style={{ height: 4, backdropFilter: "saturate(180%) blur(20px)" }} />
      <View testID="mask" style={{ height: 4, maskImage: "linear-gradient(black 70%, transparent)" }} />
      <View testID="no-mask" style={{ height: 4, maskImage: "none" }} />
      <View testID="material" style={{ height: 4, backdropFilter: "blur(30px)" }} ios={{ backdropMaterial: "regular" }} />
      <View testID="material-chrome" style={{ height: 4, backdropFilter: "blur(10px)" }} ios={{ backdropMaterial: "chrome" }} />
      <View testID="no-material" style={{ height: 4, backdropFilter: "blur(10px)" }} ios={{ backdropMaterial: "ultraThin" }} />
      <View testID="material-thin" style={{ height: 4, backdropFilter: "blur(30px)" }} ios={{ backdropMaterial: "thin" }} />
      <View testID="material-thick" style={{ height: 4, backdropFilter: "blur(30px)" }} ios={{ backdropMaterial: "thick" }} />
      <View testID="material-change" ios={{ backdropMaterial: material() }} style={{ height: 20, backdropFilter: "blur(30px)" }}
        onPress={() => material.set(material() === "regular" ? "chrome" : undefined)}>
        <Text>Change material</Text>
      </View>
      <View testID="glass" style={{ height: 4, backdropFilter: "blur(10px)", glassEffect: "regular" }} />
      <View testID="glass-clear" style={{ height: 4, glassEffect: "clear" }} />
      <View testID="no-glass" style={{ height: 4, glassEffect: "none" }} />
      {BLENDS.map((mode) => (
        <View testID={`blend-${mode}`} style={{ height: 2, mixBlendMode: mode }} />
      ))}
    </View>
  );
}

export default App;
