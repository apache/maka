import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

const id = signal("guide");
const value = signal("guide");

mount(() => <Window id="main">{() => (
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
          lineHeight: 27,
          letterSpacing: 2,
          fontFamily: "Inter, sans-serif",
          textDecorationLine: "underline line-through",
        }}
      >
        {value()}
      </Text>{" "}
      <Text testID="loose" class="leading-loose tracking-wide" style={{ fontSize: 10 }}>
        loose
      </Text>
    </Text>
    <View onPress={() => id.set("renamed")}><Text>Rename ID</Text></View>
    <View onPress={() => value.set("")}><Text>Empty span</Text></View>
  </View>
)}</Window>);
