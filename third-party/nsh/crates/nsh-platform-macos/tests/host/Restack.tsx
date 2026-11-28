// Two panels, each raised (its zIndex) by a press: the press that focuses
// the input inside a panel restacks it, and the input must keep the focus.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Window } from "nsh/desktop";

function App() {
  const top = signal("a");
  const values: Record<string, ReturnType<typeof signal<string>>> = {
    a: signal(""),
    b: signal(""),
  };
  const panel = (id: string, left: number) => (
    <View
      style={{
        position: "absolute",
        left,
        top: 20,
        width: 192,
        height: 96,
        padding: 8,
        zIndex: top() === id ? 2 : 1,
      }}
      onMouseUp={() => top.set(id)}
    >
      <Input
        testID={`input-${id}`}
        value={values[id]!()}
        onChange={(e) => values[id]!.set(e.value)}
        style={{ height: 32 }}
      />
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      {panel("a", 20)}
      {panel("b", 240)}
      <Text style={{ position: "absolute", left: 20, top: 160 }}>
        {`a=${values.a!()} b=${values.b!()} top=${top()}`}
      </Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
