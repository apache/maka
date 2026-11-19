import { Text, View, WebView, signal, type WebViewRef } from "nsh";

export default function App() {
  const result = signal("Ready");
  let page!: WebViewRef;
  return <View style={{ flex: 1, paddingTop: 64 }}>
    <View testID="evaluate" onPress={async () => {
      const available = await WebView.evaluateAvailable();
      const failures: string[] = [];
      for (const call of [
        () => page.evaluate(123 as unknown as string),
        () => page.evaluate("1", { timeout: -1 }),
      ]) {
        try { await call(); failures.push("resolved"); }
        catch (error) { failures.push((error as Error).name); }
      }
      let code = "resolved";
      try { await page.evaluate("1 + 2", { timeout: 1000 }); }
      catch (error) { code = (error as Error & { code: string }).code; }
      page.injectJavaScript("globalThis.compat = true");
      result.set(`Evaluation: ${available}/${failures.join(",")}/${code}`);
    }}><Text>Evaluate</Text></View>
    <Text>{result()}</Text>
    <WebView ref={page} html="<title>Compat</title>" style={{ width: 200, height: 120 }} />
  </View>;
}
