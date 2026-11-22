// A case of the API's test suite (docs/dev/compatibility.md): `ColorPicker`
// of `nsh/base` and its parts, a color picked with no look of its own. The
// root holds the color, owned by the app (`value`) or by the picker
// (`defaultValue`), reports it as it changes and when a change ends
// (`onChange`, `onChangeEnd`, each with the color written as `format`
// says), and turns off its parts (`disabled`). Inside it: `ColorArea`, the
// saturation and brightness of HSB under a draggable thumb (its
// `panelClass`, `panelStyle`, `thumbClass`, `thumbStyle`, `fillThumb`);
// `ColorSlider`, a channel of any space along a track (`colorSpace`,
// `channel`, `axis`, `trackClass`, `trackStyle`, `thumbClass`,
// `thumbStyle`, `fillThumb`, an alpha track's `checkerboardColor` and
// `checkerboardSize`); `ColorField`, the whole color as text in any CSS form
// or a channel's number (`channel`, `colorSpace`, `format`, `placeholder`);
// `ColorSwatch`, a preset a press picks (`color`, `selectedStyle`, its
// `checkerboardColor` and `checkerboardSize`, `onPress`) or, without a
// color, the picker's own; `ColorEyeDropper`, a button picking a color on
// the screen, disabled where the platform has no eyedropper (as headless
// runs). Each control is an adjustable element or a field
// for screen readers (`accessibilityLabel`).
import { Text, View, signal } from "nsh";
import { ColorArea, ColorEyeDropper, ColorField, ColorPicker, ColorSlider, ColorSwatch } from "nsh/base";

function App() {
  const color = signal("#ff0000");
  const formatted = signal("none");
  const ended = signal("none");
  const own = signal("none");
  const chip = signal("none");
  const disabled = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4, alignItems: "flex-start" }}>
      <ColorPicker
        value={color()}
        format="rgb"
        disabled={disabled()}
        onChange={({ value, formatted: text }) => {
          color.set(value);
          formatted.set(text);
        }}
        onChangeEnd={({ formatted: text }) => ended.set(`end ${text}`)}
      >
        <ColorArea
          testID="area"
          class="w-[200px] h-[100px]"
          accessibilityLabel="Area"
          panelClass="rounded-lg"
          panelStyle={{ opacity: 0.5 }}
          thumbClass="w-[10px] h-[10px]"
          thumbStyle={{ borderWidth: 2 }}
          fillThumb
        />
        <ColorSlider
          testID="hue"
          class="w-[200px] h-[20px] justify-center"
          colorSpace="hsl"
          channel="hue"
          accessibilityLabel="Hue"
          trackClass="h-[10px]"
          trackStyle={{ borderRadius: 5 }}
          thumbClass="w-[10px] h-[10px]"
          thumbStyle={{ borderWidth: 1 }}
          fillThumb
        />
        <ColorSlider
          testID="alpha"
          class="w-[20px] h-[100px] items-center"
          channel="alpha"
          axis="vertical"
          accessibilityLabel="Alpha"
          trackClass="w-[10px] h-full"
          thumbClass="w-[10px] h-[10px]"
          checkerboardColor="#cccccc"
          checkerboardSize={5}
        />
        <ColorSlider
          class="w-[200px] h-[20px] justify-center"
          colorSpace="oklch"
          channel="lightness"
          accessibilityLabel="Lightness"
          trackClass="h-[10px]"
          thumbClass="w-[10px] h-[10px] disabled:w-[6px]"
          disabled
        />
        <ColorField accessibilityLabel="Hex" placeholder="Color" format="hex" class="w-[200px] h-[30px]" />
        <ColorField accessibilityLabel="Red" channel="red" colorSpace="rgb" class="w-[200px] h-[30px]" />
        <View style={{ flexDirection: "row", gap: 4 }}>
          <ColorSwatch
            color="#0000ff80"
            accessibilityLabel="Blue"
            class="w-[20px] h-[20px]"
            selectedStyle={{ borderWidth: 2 }}
            checkerboardColor="#cccccc"
            checkerboardSize={10}
          >
            <View testID="check" style={{ width: 4, height: 4 }} />
          </ColorSwatch>
          <ColorSwatch testID="preview" class="w-[20px] h-[20px]" />
          <ColorEyeDropper accessibilityLabel="Eyedropper" class="w-[20px] h-[20px]" onPick={({ color: value }) => color.set(value)}>
            <View testID="dropper" style={{ width: 4, height: 4 }} />
          </ColorEyeDropper>
        </View>
      </ColorPicker>
      <Text>{`Color ${color()}`}</Text>
      <Text>{`Formatted ${formatted()}`}</Text>
      <Text>{ended()}</Text>
      <View testID="disable" onPress={() => disabled.set(!disabled())} style={{ width: 20, height: 20 }} />
      <ColorPicker defaultValue="#00ff00" format="oklch" onChangeEnd={({ formatted }) => own.set(formatted)}>
        <ColorSlider
          class="w-[200px] h-[20px] justify-center"
          channel="brightness"
          accessibilityLabel="Brightness"
          trackClass="h-[10px]"
          thumbClass="w-[10px] h-[10px]"
        />
      </ColorPicker>
      <Text>{`Own ${own()}`}</Text>
      <ColorSwatch
        color="#ffff00"
        accessibilityLabel="Yellow"
        class="w-[20px] h-[20px]"
        disabled={false}
        onPress={({ color }) => chip.set(color)}
      />
      <Text>{`Chip ${chip()}`}</Text>
    </View>
  );
}

export default App;
