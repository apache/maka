import { type InputRef, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A field that selects its whole text when it takes the focus
// (`selectTextOnFocus`) and one that does not, each showing the selection
// it reports, and a button that focuses the first (`focus()`).
function App() {
  let select: InputRef | undefined;
  const field = (name: string, selectTextOnFocus: boolean) => {
    const selection = signal("none");
    return (
      <View>
        <Input
          testID={name}
          ref={(r) => {
            if (selectTextOnFocus) select = r;
          }}
          selectTextOnFocus={selectTextOnFocus}
          defaultValue="Hello"
          onSelectionChange={(e) => selection.set(`${e.start}-${e.end}`)}
          style={{ height: 40 }}
        />
        <Text>{`${name}: ${selection()}`}</Text>
      </View>
    );
  };
  return (
    <View style={{ flex: 1 }}>
      {field("select", true)}
      {field("plain", false)}
      <View onPress={() => select?.focus()} style={{ height: 40 }}>
        <Text>Focus</Text>
      </View>
    </View>
  );
}

mount(App);
