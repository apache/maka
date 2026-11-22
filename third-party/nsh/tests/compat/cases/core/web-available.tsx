// A case of the API's test suite (docs/dev/compatibility.md): asking
// whether a web view shows a page here (`WebView.available()`), which the
// headless backend does, and a web view listening for its `onError` (the
// `code` `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the platform shows
// none), which stays silent where web views show.
import { Text, View, WebView, signal } from "nsh";

function App() {
  const available = signal("asking");
  const failed = signal("No error");
  WebView.available().then((v) => available.set(`Web views available: ${v}`));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{available()}</Text>
      <Text>{failed()}</Text>
      <WebView
        html="<p>compat</p>"
        onError={(e) => failed.set(`Error ${e.code ?? "none"}`)}
        style={{ width: 200, height: 120 }}
      />
    </View>
  );
}

export default App;
