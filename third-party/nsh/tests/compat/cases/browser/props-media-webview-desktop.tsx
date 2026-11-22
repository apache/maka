// A case of the API's test suite (docs/dev/compatibility.md): a web view's
// desktop props, run as on macOS (`platform macos`): the swipes back and
// forward from `desktop={{…}}`, not the ones `ios={{…}}` turns off. Its script checks it.
import { View } from "nsh";
import { WebView } from "nsh";

function App() {
  return (
    <View style={{ flex: 1 }}>
      <WebView
        testID="page"
        src="https://example.com/"
        ios={{ allowsBackForwardNavigationGestures: false }}
        desktop={{ allowsBackForwardNavigationGestures: true }}
        style={{ width: 400, height: 300 }}
      />
    </View>
  );
}

export default App;
