// A case of the API's test suite (docs/dev/compatibility.md): a
// `NavStack`'s `onChange({ routes })`: not for the routes it starts with,
// then once per change, with the routes after it. Its script checks each.
import { Text, View, signal } from "nsh";
import { Button, NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack<string>(["home"]);

export default function BaseNavStackChange() {
  const changes = signal<string[]>([]);
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Text>{`Changes: ${changes().length} ${changes().join(" | ") || "none"}`}</Text>
      <Button onPress={() => nav.push(`p${nav.routes().length}`)}>
        <Text>Push</Text>
      </Button>
      <Button onPress={() => nav.pop()}>
        <Text>Pop</Text>
      </Button>
      <NavStack state={nav} style={{ height: 200 }} onChange={({ routes }) => changes.set([...changes(), routes.join(">")])}>
        {(route) => (
          <NavPage>
            <Text>{`Page ${route}`}</Text>
          </NavPage>
        )}
      </NavStack>
    </View>
  );
}
