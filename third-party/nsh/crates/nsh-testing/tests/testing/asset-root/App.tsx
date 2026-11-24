import { mount, Text } from "nsh";
import { Window } from "nsh/desktop";

mount(() => <Window id="main">{() => <Text>The app</Text>}</Window>);
