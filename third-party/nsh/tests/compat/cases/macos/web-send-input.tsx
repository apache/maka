// A case of the API's test suite (docs/dev/compatibility.md): a web view's
// ref giving its page trusted input with `sendInput`, which the macos
// domain's capabilities grant (`webview.input`), and `WebView.inputAvailable()`
// reporting no support in the headless backend. A script cannot observe
// a ref's commands; the case checks that the calls of each form are made.
import { Text, View, WebView, signal } from "nsh";

function App() {
  const sent = signal("");
  const available = signal("asking");
  WebView.inputAvailable().then((v) => available.set(`Input available: ${v}`));
  let page: any;
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="send"
        onPress={() => {
          page.sendInput({ type: "click", x: 20, y: 20 });
          page.sendInput({ type: "text", text: "a b!" });
          page.sendInput({ type: "key", key: "Enter" });
          sent.set("Sent input");
        }}
      >
        <Text>Send</Text>
      </View>
      <Text>{available()}</Text>
      <Text>{sent()}</Text>
      <WebView
        ref={(n: any) => (page = n)}
        html="<input autofocus>"
        style={{ width: 200, height: 120 }}
      />
    </View>
  );
}

export default App;
