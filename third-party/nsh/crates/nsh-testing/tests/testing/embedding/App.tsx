// The embedding app's part, as a test plays it (`open`'s `host`): launch
// parameters, events, calls the test's handlers answer, posts it records,
// and the URLs the app opens, recorded instead of opened.
import { mount, signal, Text, View } from "nsh";
import { host } from "nsh/host";
import { openUrl } from "nsh/device";
import { TextView } from "nsh/base";

const user = typeof host.params.user === "string" ? host.params.user : "guest";

function Press(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  const message = signal("no message");
  const answer = signal("no answer");
  const opened = signal("nothing opened");
  host.on<{ text: string }>("message", ({ text }) => message.set(`message ${text}`));
  const ask = (name: string) =>
    host.call<{ name: string }>(name, { id: 7 }).then(
      (profile) => answer.set(`answer ${profile.name}`),
      (e: Error) => answer.set(`failed ${e.message}`),
    );
  return (
    <View style={{ flex: 1, paddingTop: 40 }}>
      <Text>{`Hello, ${user}`}</Text>
      <Text>{message()}</Text>
      <Text>{answer()}</Text>
      <Text>{opened()}</Text>
      <Press label="Ask" onPress={() => ask("profile")} />
      <Press label="Ask the fixed" onPress={() => ask("fixed")} />
      <Press label="Ask the failing" onPress={() => ask("failing")} />
      <Press label="Ask nobody" onPress={() => ask("nobody")} />
      <Press label="Post" onPress={() => host.post("analytics", { screen: "home" })} />
      <Press
        label="Open"
        onPress={async () => opened.set(`opened ${await openUrl("https://example.com/help")}`)}
      />
      <TextView markdown="Read [the guide](mailto:guide@example.com)." links="open" />
    </View>
  );
}

mount(App);
