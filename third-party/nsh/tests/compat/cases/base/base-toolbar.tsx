// A case of the API's test suite (docs/dev/compatibility.md): `Toolbar`,
// `ToolbarGroup` and `ToolbarSeparator` of `nsh/base`, a bar of controls
// with no look of its own: the roles and names screen readers get
// (`accessibilityLabel`), its items (`Button`, `Toggle`, `Link`, a
// `ToggleGroup` inside it as one of its groups), the toolbar as one stop of
// the keyboard focus (only its first enabled item is `focusable`), the
// direction `axis` lays its children out in, and `disabled` on the toolbar
// and on a group. Every item is 20 points square, so its frame says where
// the toolbar put it.
import { Text, View, signal } from "nsh";
import { Button, Link, Toggle, ToggleGroup, Toolbar, ToolbarGroup, ToolbarSeparator } from "nsh/base";

const item = { width: 20, height: 20 };

function App() {
  const pressed = signal("none");
  const bold = signal(false);
  const locked = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Toolbar testID="bar" accessibilityLabel="Formatting" disabled={locked()}>
        <ToolbarGroup testID="history" accessibilityLabel="History">
          <Button testID="undo" accessibilityLabel="Undo" style={item} onPress={() => pressed.set("undo")} />
          <Button testID="redo" accessibilityLabel="Redo" style={item} disabled onPress={() => pressed.set("redo")} />
        </ToolbarGroup>
        <ToolbarSeparator testID="sep" style={{ width: 2, height: 20 }} />
        <ToggleGroup testID="marks">
          <Toggle testID="bold" accessibilityLabel="Bold" style={item} pressed={bold()} onChange={({ pressed: on }) => bold.set(on)} />
        </ToggleGroup>
        <ToolbarGroup testID="share" accessibilityLabel="Share" disabled>
          <Button testID="send" accessibilityLabel="Send" style={item} onPress={() => pressed.set("send")} />
        </ToolbarGroup>
        <Link testID="help" href="/help" openWith="app" style={item} onPress={() => pressed.set("help")} />
      </Toolbar>
      <Toolbar testID="tools" axis="vertical" accessibilityLabel="Tools">
        <Button testID="select" accessibilityLabel="Select" style={item} onPress={() => pressed.set("select")} />
        <Button testID="pen" accessibilityLabel="Pen" style={item} onPress={() => pressed.set("pen")} />
      </Toolbar>
      <Text>{`Pressed: ${pressed()}`}</Text>
      <Text>{`Bold: ${bold()}`}</Text>
      <View testID="lock" onPress={() => locked.set(!locked())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
