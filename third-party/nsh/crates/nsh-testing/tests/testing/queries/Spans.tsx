import { mount, signal, Text, View } from "nsh";

const id = signal("guide");
const value = signal("guide");

mount(() => (
  <View>
    <Text testID="paragraph">
      See{" "}
      <Text
        testID={id()}
        class="font-bold italic"
        style={{
          color: "#123456",
          backgroundColor: "#fedcba",
          fontSize: 18,
          textDecorationLine: "underline line-through",
        }}
      >
        {value()}
      </Text>
    </Text>
    <View onPress={() => id.set("renamed")}><Text>Rename ID</Text></View>
    <View onPress={() => value.set("")}><Text>Empty span</Text></View>
  </View>
));
