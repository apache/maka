// A case of the API's test suite (docs/dev/compatibility.md): `nsh`'s
// `Share` on the headless runtime, which has no share sheet: `available()`
// resolves false and `show` rejects with ERR_FEATURE_UNAVAILABLE_ON_PLATFORM,
// never resolving as shared. `show` returns a promise that never throws:
// content with nothing to share (empty text is none) rejects with a
// `TypeError`, a `file:` URL too, more than 100 files and a URL past 16 KiB
// with a `RangeError`, and a file no
// `capabilities.fs.read` grant covers with ERR_ACCESS_DENIED. Its script
// checks each.
import { Share, Text, View, type ShareResult, type ViewRef, signal } from "nsh";

function App() {
  const available = signal("unknown");
  const shown = signal("not shown");
  const empty = signal("none");
  const local = signal("none");
  const many = signal("none");
  const file = signal("none");
  const blank = signal("none");
  const long = signal("none");
  let button: ViewRef | undefined;
  Share.available().then((yes: boolean) => available.set(`${yes}`));
  const outcome = (promise: Promise<ShareResult>, into: typeof shown) => {
    into.set(typeof promise.then === "function" ? "pending" : "not a promise");
    promise.then(
      (result) => into.set(`resolved ${result.action} ${result.target}`),
      (e: Error & { code?: string }) => into.set(`rejected ${e.code ?? e.name}`),
    );
  };
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Available: ${available()}`}</Text>
      <Text>{`Shown: ${shown()}`}</Text>
      <Text>{`Empty: ${empty()}`}</Text>
      <Text>{`Local URL: ${local()}`}</Text>
      <Text>{`Many: ${many()}`}</Text>
      <Text>{`File: ${file()}`}</Text>
      <Text>{`Blank: ${blank()}`}</Text>
      <Text>{`Long URL: ${long()}`}</Text>
      <View
        testID="share"
        ref={button}
        onPress={() => {
          try {
            outcome(Share.show({ title: "Docs", text: "Read this", url: "https://example.com/docs", anchor: button }), shown);
            outcome(Share.show({ title: "Only a title" }), empty);
            outcome(Share.show({ url: "file:///etc/hosts" }), local);
            outcome(Share.show({ files: Array.from({ length: 101 }, (_, i) => `/tmp/${i}.txt`) }), many);
            outcome(Share.show({ files: ["/tmp/report.pdf"] }), file);
            outcome(Share.show({ title: "Notes", text: "" }), blank);
            outcome(Share.show({ url: `https://example.com/${"a".repeat(17000)}` }), long);
          } catch (e) {
            shown.set(`threw ${(e as Error).name}`);
          }
        }}
      >
        <Text>Share</Text>
      </View>
    </View>
  );
}

export default App;
