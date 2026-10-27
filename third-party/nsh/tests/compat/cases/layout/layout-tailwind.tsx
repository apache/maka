// A case of the API's test suite (docs/dev/compatibility.md): layout
// classes that mean what they mean in a browser. `static` ignores its
// insets, in any order; `fixed` lays a view out in its root view's box;
// `inline-block` is a block (no gap between its children); `space-x-*` puts
// a margin after each child but the last (negative ones too); right to
// left, `ml-*` / `mr-*` stay on their side, and so does the `marginRight`
// key, as in CSS; `max-*` breakpoints sort widest first, so the narrowest
// wins. Arbitrary values, as this domain's theme has a spacing of its own.
// The script checks each frame.
import { Text, View } from "nsh";

function App() {
  return (
    <View>
      <Text>Tailwind layout</Text>
      <View testID="static-frame" style={{ width: 300, height: 60 }}>
        <View testID="static-style" style={{ position: "static", top: 10, left: 7, width: 50, height: 20 }} />
        <View testID="static-class" class="relative top-[10px] left-[7px] static w-[50px] h-[20px]" />
      </View>
      <View testID="fixed-frame" style={{ width: 300, height: 30, padding: 10 }}>
        <View testID="fixed" class="fixed top-[3px] left-[5px] w-[40px] h-[10px]" />
        <View testID="after-fixed" style={{ width: 50, height: 10 }} />
      </View>
      <View testID="inline-block" class="inline-block gap-[10px] w-[300px]">
        <View testID="inline-block-a" style={{ width: 50, height: 20 }} />
        <View testID="inline-block-b" style={{ width: 50, height: 20 }} />
      </View>
      <View testID="space" class="flex-row space-x-[10px] w-[300px] h-[20px]">
        <View testID="space-a" style={{ width: 50, height: 20 }} />
        <View testID="space-b" style={{ width: 50, height: 20 }} />
        <View testID="space-c" style={{ width: 50, height: 20 }} />
      </View>
      <View testID="overlap" class="flex-row -space-x-[10px] w-[300px] h-[20px]">
        <View testID="overlap-a" style={{ width: 50, height: 20 }} />
        <View testID="overlap-b" style={{ width: 50, height: 20 }} />
      </View>
      <View testID="content-box" class="box-content w-[100px] h-[20px] p-[10px] border-[2px]" />
      <View class="flex-row space-x-[20px]! w-[200px] h-[20px]">
        <View class="w-[30px] h-[20px] mr-0" />
        <View testID="important-space" class="w-[30px] h-[20px]" />
      </View>
      <View class="relative w-[200px] h-[80px] p-[20px]">
        <View class="static w-[100px] h-[40px]">
          <View testID="static-containing-block" class="absolute left-0 top-0 size-[10px]" />
        </View>
      </View>
      <View>
        <View testID="variant-order" class="h-[20px] max-md:w-[20px] max-lg:w-[40px]" />
      </View>
      <View style={{ direction: "rtl" }}>
        <View testID="rtl-classes" class="flex-row w-[300px] h-[20px]">
          <View testID="rtl-ml" class="ml-[10px] w-[50px] h-[20px]" />
        </View>
        <View class="flex-row w-[300px] h-[20px]">
          <View testID="rtl-mr" class="mr-[10px] w-[50px] h-[20px]" />
        </View>
        <View class="flex-row w-[300px] h-[20px]">
          <View testID="rtl-key" style={{ marginRight: 10, width: 50, height: 20 }} />
        </View>
      </View>
    </View>
  );
}

export default App;
