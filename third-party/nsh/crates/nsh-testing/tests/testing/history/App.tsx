import { mount, Text } from "nsh";
import { Window } from "nsh/desktop";

function App() {
  return <Text>Home</Text>;
}

mount(() => <Window id="main">{App}</Window>);
