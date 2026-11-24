// A case of the API's test suite (docs/dev/compatibility.md): `TitleBar` of
// `nsh/base`, the row an app draws as its window's title bar. Here (no
// window controls to keep clear of) it is a row of its children with no
// padding of its own, as tall as the app styles it; the controls in it
// still take their presses. Every item is 20 points square.
import { Text, View, signal } from "nsh";
import { Button, TitleBar } from "nsh/base";

const item = { width: 20, height: 20 };

function App() {
  const pressed = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <TitleBar testID="bar" style={{ height: 30 }}>
        <Button testID="back" accessibilityLabel="Back" style={item} onPress={() => pressed.set("back")} />
        <View testID="title" style={{ flex: 1, height: 20 }} />
        <Button testID="share" accessibilityLabel="Share" style={item} onPress={() => pressed.set("share")} />
      </TitleBar>
      <Text>{`Pressed: ${pressed()}`}</Text>
    </View>
  );
}

export default App;
