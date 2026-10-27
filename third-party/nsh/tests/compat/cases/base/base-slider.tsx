// A case of the API's test suite (docs/dev/compatibility.md): `Slider` of
// `nsh/base`, a value or a range picked along a track, with no look of its
// own: each thumb an adjustable element with its label and value for
// screen readers (`accessibilityLabel`, `startAccessibilityLabel`), drags
// of a thumb and presses on the track reporting the values (`onChange`,
// snapped to `step` between `min` and `max`) and the end of the change
// (`onChangeEnd`) while the app owns the value (`value`), or the slider
// its own (`defaultValue`, here on a `logarithmic` `scale` along a
// `vertical` `axis`), `disabled`, and the app's look of its track,
// indicator, range and thumbs (`trackClass`, `trackStyle`,
// `indicatorClass`, `indicatorStyle`, `rangeClass`, `rangeStyle`,
// `thumbClass`, `thumbStyle`), whose `disabled:` classes follow the
// slider. The parts' frames are how its script sees them.
import { Text, View, signal } from "nsh";
import { Slider } from "nsh/base";

const parts = {
  class: "w-[200px]",
  trackClass: "h-[20px] justify-center",
  trackStyle: { marginTop: 0 },
  indicatorClass: "h-[4px]",
  indicatorStyle: { backgroundColor: "#cccccc" },
  rangeClass: "rounded-full",
  rangeStyle: { backgroundColor: "#00ff00" },
  thumbClass: "w-[10px] h-[10px] disabled:w-[6px]",
  thumbStyle: { backgroundColor: "#0000ff" },
};

function App() {
  const volume = signal(40);
  const price = signal<[number, number]>([200, 600]);
  const ended = signal("none");
  const zoom = signal("none");
  const disabled = signal(true);
  const locked = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Slider
        testID="volume"
        value={volume()}
        step={5}
        accessibilityLabel="Volume"
        onChange={next => volume.set(next as number)}
        onChangeEnd={next => ended.set(`end ${next}`)}
        {...parts}
      >
        <Text>{`Volume ${volume()}`}</Text>
      </Slider>
      <Text>{ended()}</Text>
      <Slider
        testID="price"
        value={price()}
        min={0}
        max={1000}
        step={10}
        scale="linear"
        accessibilityLabel="Max price"
        startAccessibilityLabel="Min price"
        onChange={next => price.set(next as [number, number])}
        {...parts}
      />
      <Text>{`Price ${price()[0]}-${price()[1]}`}</Text>
      <Slider
        testID="zoom"
        defaultValue={10}
        min={1}
        max={1000}
        scale="logarithmic"
        axis="vertical"
        accessibilityLabel="Zoom"
        onChangeEnd={next => zoom.set(`zoom ${next}`)}
        trackClass="w-[20px] h-[150px] items-center"
        indicatorClass="w-[4px] h-full"
        thumbClass="w-[10px] h-[10px]"
      />
      <Text>{zoom()}</Text>
      <Slider
        testID="locked"
        value={50}
        disabled={disabled()}
        accessibilityLabel="Locked"
        onChange={next => locked.set(String(next))}
        {...parts}
      />
      <Text>{`Locked ${locked()}`}</Text>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
