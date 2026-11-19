import { mount, signal, Text, View } from "nsh";

const dimmed = signal(false);

mount(() => (
  <View testID="panel" style={{ opacity: 0.5 }}>
    <View
      testID="card"
      style={{ backgroundColor: "#336699", opacity: dimmed() ? 0.4 : 1 }}
    >
      <Text>Card</Text>
    </View>
    <View testID="plain">
      <Text>Plain</Text>
    </View>
    <View onPress={() => dimmed.set(!dimmed())}><Text>Dim</Text></View>
  </View>
));
