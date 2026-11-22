import { mount, signal, Text, View } from "nsh";

/** What fetching `url` came to: its status, or why it was refused. */
function fetched(url: string) {
  const shown = signal("waiting");
  fetch(url).then(
    (r) => shown.set(`ok ${r.status}`),
    (e: Error & { code?: string }) => shown.set(`refused ${e.code}`),
  );
  return shown;
}

function App() {
  const declared = fetched("https://api.test/declared");
  const other = fetched("https://other.test/undeclared");
  return (
    <View>
      <Text>{`declared: ${declared()}`}</Text>
      <Text>{`other: ${other()}`}</Text>
    </View>
  );
}

mount(App);
