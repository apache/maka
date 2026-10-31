// A case of the API's test suite (docs/dev/compatibility.md): a script run
// as on macOS (`platform macos`), where `desktop={{…}}` props apply and
// `ios={{…}}` ones do not, and `platform` agrees: `desktop` true, the
// `desktop` idiom and `select`'s `desktop`.
import { platform, Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1 }}>
      <Text>{`Desktop: ${platform.desktop} ${platform.idiom} ${platform.select({ mobile: "mobile", desktop: "desktop" })}`}</Text>
      <View testID="bar" desktop={{ windowDrag: true }} style={{ height: 44 }}>
        <Text>Title bar</Text>
      </View>
      <View testID="body" desktop={{ windowDrag: false }} style={{ flex: 1 }} />
    </View>
  );
}

export default App;
