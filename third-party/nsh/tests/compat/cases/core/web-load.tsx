// A case of the API's test suite (docs/dev/compatibility.md): a web view's
// ref loading a page with headers on its request (`load`), as an app opens
// a signed-in page, and refusing a header that could start another. A
// script cannot observe a ref's commands; the case checks that the call is
// made and that the invalid one throws a `TypeError`.
import { Text, View, WebView, signal } from "nsh";
import type { WebViewRef } from "nsh";

function App() {
  const result = signal("");
  let page!: WebViewRef;
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="load"
        onPress={() => {
          page.load({ src: "https://example.com/", headers: { Authorization: "Bearer compat" } });
          let threw = "none";
          try {
            page.load({ src: "https://example.com/", headers: { Authorization: "a\r\nX-Other: b" } });
          } catch (e) {
            threw = e instanceof TypeError ? "TypeError" : String(e);
          }
          result.set(`Loaded, invalid header: ${threw}`);
        }}
      >
        <Text>Load</Text>
      </View>
      <Text>{result()}</Text>
      <WebView ref={page} style={{ width: 200, height: 120 }} />
    </View>
  );
}

export default App;
