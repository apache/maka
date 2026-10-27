// A case of the API's test suite (docs/dev/compatibility.md): where an
// image sits in its box (`objectPosition`, CSS's `object-position`) as the
// platform receives it: the center by default, keywords in either order,
// percentages and lengths, edges with offsets, Tailwind's `object-*`
// classes and an arbitrary one, and a change the app makes.
import { Image, Text, View, signal } from "nsh";

const SRC = "https://example.com/tall.png";

function PaintObjectPosition() {
  const top = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Object position</Text>
      <View testID="flip" onPress={() => top.set(false)}>
        <Text>Flip</Text>
      </View>
      <Image testID="centered" src={SRC} style={{ width: 16, height: 16 }} />
      <Image testID="top" src={SRC} style={{ width: 16, height: 16, objectPosition: "top" }} />
      <Image testID="top-left" src={SRC} style={{ width: 16, height: 16, objectPosition: "top left" }} />
      <Image testID="bottom-right" src={SRC} style={{ width: 16, height: 16, objectPosition: "right bottom" }} />
      <Image testID="percent" src={SRC} style={{ width: 16, height: 16, objectPosition: "25% 75%" }} />
      <Image testID="lengths" src={SRC} style={{ width: 16, height: 16, objectPosition: "10px 1rem" }} />
      <Image testID="edges" src={SRC} style={{ width: 16, height: 16, objectPosition: "right 10px bottom 20%" }} />
      <Image testID="class-top" src={SRC} class="size-4 object-cover object-top" />
      <Image testID="class-bottom-left" src={SRC} class="size-4 object-bottom-left" />
      <Image testID="class-arbitrary" src={SRC} class="size-4 object-[right_4px_top_50%]" />
      <Image
        testID="changed"
        src={SRC}
        style={{ width: 16, height: 16, objectPosition: top() ? "top" : "bottom" }}
      />
    </View>
  );
}

export default PaintObjectPosition;
