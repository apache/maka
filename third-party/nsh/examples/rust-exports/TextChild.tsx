import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Window } from "nsh/desktop";
import { TextChild } from "rust-exports/native";

function App() {
  const source = signal("**First**");
  return (
    <View>
      <TextChild>**Literal**</TextChild>
      <TextChild>{source()}</TextChild>
      <Button onPress={() => source.set("**Second**")}>
        <Text>Update child</Text>
      </Button>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
