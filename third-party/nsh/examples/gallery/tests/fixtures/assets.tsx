import { mount, signal, Text, View } from "nsh";
import flag from "./flag.png";

// What `fetch` answers for a file the app ships (`asset:/`) and for one it
// does not: on the web too, where the browser knows no `asset:` scheme.
async function read(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    const bytes = await response.bytes();
    const signature = String.fromCharCode(...bytes.slice(1, 4));
    return `${response.status} ${response.headers.get("content-type")} ${signature} ${response.url === url}`;
  } catch (error) {
    return (error as Error).name;
  }
}

function App() {
  const file = signal("reading");
  const missing = signal("reading");
  read(flag.url).then((line) => file.set(line));
  read("asset:/missing.png").then((line) => missing.set(line));
  return (
    <View style={{ flex: 1, paddingTop: 100 }}>
      <Text>{`File: ${file()}`}</Text>
      <Text>{`Missing: ${missing()}`}</Text>
    </View>
  );
}

mount(App);
