import { mount, Text, View } from "nsh";
import { Window } from "nsh/desktop";

mount(() => <Window id="main">{() => (
  <View testID="panel" style={{ padding: 10, width: 200, height: 100, overflow: "hidden" }}>
    <View testID="box" style={{ width: 80, height: 40 }}>
      <Text>Box</Text>
    </View>
    <View testID="wide" style={{ width: 300, height: 20 }} />
    <View role="button" accessibilityLabel="Send" accessibilityState={{ disabled: true }} style={{ width: 40, height: 20 }}>
      <View role="image" accessibilityLabel="Arrow" style={{ width: 10, height: 10 }} />
    </View>
    <View role="checkbox" accessibilityLabel="Agree" accessibilityState={{ checked: true }} style={{ width: 20, height: 20 }} />
  </View>
)}</Window>);
