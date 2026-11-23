// A WKWebView whose scripts the app evaluates. `WebView.test.tsx` runs it on
// the macOS host.
import { mount, signal, Text, View, WebView, type WebViewRef } from "nsh";
import { Button } from "nsh/base";

function App() {
  let page!: WebViewRef;
  const result = signal("none");
  const run = async (script: string) => {
    try {
      const { value } = await page.evaluate(script, { timeout: 5000 });
      result.set(JSON.stringify(value));
    } catch (e) {
      result.set(`${(e as Error & { code?: string }).code}`);
    }
  };
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <WebView ref={page} html="<title>Page</title><p>Page</p>" style={{ width: 200, height: 120 }} />
      <Text>{`Result: ${result()}`}</Text>
      <Button onPress={() => run("1 + 1")} style={{ minHeight: 44 }}>
        <Text>Sum</Text>
      </Button>
      <Button onPress={() => run("Promise.resolve(document.title)")} style={{ minHeight: 44 }}>
        <Text>Title</Text>
      </Button>
    </View>
  );
}

mount(App);
