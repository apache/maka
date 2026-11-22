import { mount, Scroll, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

mount(() => {
  const pressed = signal("none");
  return (
    <View style={{ flex: 1 }}>
      <Text>Pressed: {pressed()}</Text>
      <Scroll style={{ height: 96 }}>
        <Button onPress={() => pressed.set("Start")}><Text>Start</Text></Button>
        <View style={{ height: 192 }} />
        <Button onPress={() => pressed.set("Team")}><Text>Team</Text></Button>
        <View style={{ height: 96 }} />
      </Scroll>
    </View>
  );
});
