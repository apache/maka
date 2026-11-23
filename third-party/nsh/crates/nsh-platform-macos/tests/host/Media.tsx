// A page that reports whether WebKit gives it `navigator.mediaDevices` (an
// `https` origin, so a secure context). `Media.test.tsx` runs it on the
// macOS host.
import { mount, signal, Text, View, WebView } from "nsh";

const page = `<script>window.nsh.postMessage(typeof navigator.mediaDevices)</script>`;

function App() {
  const heard = signal("none");
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <WebView
        html={page}
        baseUrl="https://example.com/"
        onMessage={(e) => heard.set(String(e.data))}
        style={{ width: 200, height: 120 }}
      />
      <Text>{`Media devices: ${heard()}`}</Text>
    </View>
  );
}

mount(App);
