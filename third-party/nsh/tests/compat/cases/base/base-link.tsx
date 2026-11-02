// A case of the API's test suite (docs/dev/compatibility.md): `Link` of
// `nsh/base`, a press target that goes somewhere, with no look of its own:
// its role and label as screen readers get them (`accessibilityLabel`),
// a press reporting where it goes (`onOpen` with its `href`) before the
// press itself (`onPress`), `openWith`, `disabled` with `disabledStyle`,
// and the app's look (`class`, `hoverStyle`), all following signals. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { Link } from "nsh/base";

function App() {
  const log = signal<string[]>([]);
  const say = (s: string) => log.set([...log(), s]);
  const disabled = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Link
        testID="docs"
        href="https://example.com/docs"
        class="h-[24px] self-start"
        hoverStyle={{ opacity: 0.5 }}
        onOpen={({ href }) => say(`open ${href}`)}
        onPress={() => say("press")}
      >
        <Text>Docs</Text>
      </Link>
      <Link
        testID="order"
        href="/orders/42"
        openWith="app"
        accessibilityLabel="Order 42"
        onOpen={({ href }) => say(`route ${href}`)}
      >
        <Text>#42</Text>
      </Link>
      <Link
        testID="archived"
        href="/archive"
        openWith="app"
        disabled={disabled()}
        disabledStyle={{ opacity: 0.25 }}
        onOpen={({ href }) => say(`route ${href}`)}
      >
        <Text>Archived</Text>
      </Link>
      <Text>{`Log: ${log().join(", ")}`}</Text>
      <View testID="enable" onPress={() => disabled.set(!disabled())} style={{ height: 20 }} />
    </View>
  );
}

export default App;
