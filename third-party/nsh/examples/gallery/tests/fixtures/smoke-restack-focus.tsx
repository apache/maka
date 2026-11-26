// Two panels, each with an input; a press brings its panel to the front
// (`zIndex`). The press must still focus the input it lands on
// (longbridge/nsh#3244, longbridge/nsh#2015).
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const top = signal("a");
const values = { a: signal(""), b: signal("") };

const panel = (id: "a" | "b", left: number) => (
  <View
    class="absolute w-48 h-24 p-2 bg-gray-800"
    style={{ left, top: 20, zIndex: top() === id ? 2 : 1 }}
    onMouseUp={() => top.set(id)}
  >
    <Input testID={`input-${id}`} value={values[id]()} onChange={(e) => values[id].set(e.value)} class="h-8 bg-gray-700 text-white" />
  </View>
);

mount(() => (
  <View class="flex-1 bg-black">
    {panel("a", 20)}
    {panel("b", 240)}
    <Text testID="out" class="absolute text-white" style={{ left: 20, top: 160 }}>
      {`a=${values.a()} b=${values.b()}`}
    </Text>
  </View>
));
