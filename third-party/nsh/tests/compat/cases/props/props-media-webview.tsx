// A case of the API's test suite (docs/dev/compatibility.md): what a web
// view loads and how, as the platform receives it on iOS: a URL, then a
// page of HTML with its base URL, the scripts injected before and after
// each page's own, scripts turned off, the user agent, scrolling turned
// off and the swipes back and forward. Its script
// checks each.
import { Text, View, signal } from "nsh";
import { WebView } from "nsh";

function App() {
  const html = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="html" onPress={() => html.set(true)}>
        <Text>HTML</Text>
      </View>
      <WebView
        testID="page"
        src="https://example.com/start"
        html={html() ? "<p>Hi</p>" : undefined}
        baseUrl={html() ? "https://example.com/" : undefined}
        injectedJavaScript="window.after = 1;"
        injectedJavaScriptBeforeContentLoaded="window.before = 1;"
        javaScriptEnabled={false}
        userAgent="CompatAgent/1"
        scrollable={false}
        ios={{ allowsBackForwardNavigationGestures: true }}
        style={{ width: 200, height: 120 }}
      />
    </View>
  );
}

export default App;
