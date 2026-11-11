import { mount, signal, Text, View } from "nsh";
import hello from "../notes/hello.txt?url";
import beside from "./beside.txt?url";

// An entry below its app (`tests/`), as a test opens one: the files it
// imports are named from the app's directory, as a package holds them, and
// a literal `asset:/` URL reads from there too.
async function read(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    return `${url} ${response.status} ${(await response.text()).trim()}`;
  } catch (error) {
    return `${url} ${(error as Error).name}`;
  }
}

function App() {
  const above = signal("reading");
  const next = signal("reading");
  const literal = signal("reading");
  read(hello).then((line) => above.set(line));
  read(beside).then((line) => next.set(line));
  read("asset:/notes/hello.txt").then((line) => literal.set(line));
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Above: ${above()}`}</Text>
      <Text>{`Beside: ${next()}`}</Text>
      <Text>{`Literal: ${literal()}`}</Text>
    </View>
  );
}

mount(App);
