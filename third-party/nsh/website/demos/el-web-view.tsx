import { mount, signal, Text, View, WebView, type WebViewNavigation, type YNode } from "nsh";
import { platform, windowSize } from "nsh";
import { button, buttonText, ui } from "./palette";

// The page: a button that posts to the app, and a line that shows what the
// app posts back.
const page = (c: ReturnType<typeof ui>) => `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inline page</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 0; padding: 16px; background: ${c.page}; color: ${c.text}; }
  button { font: inherit; font-weight: 600; padding: 10px 14px; border-radius: 10px; border: 1px solid ${c.border}; background: ${c.accent}; color: ${c.page}; }
  .muted { color: ${c.muted}; }
  #got { margin-top: 12px; }
  #box { margin-top: 12px; height: 48px; border-radius: 10px; background: ${c.border}; transition: background 0.3s; }
</style>
<p class="muted">This is HTML in a web view.</p>
<button id="post">postMessage to the app</button>
<p id="got" class="muted">Nothing from the app yet.</p>
<div id="box"></div>
<script>
  let taps = 0;
  document.getElementById("post").onclick = () =>
    window.nsh.postMessage("tap " + ++taps + " from the page");
  window.addEventListener("message", (e) => { document.getElementById("got").textContent = "App says: " + e.data; });
</script>`;

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View
      onPress={props.onPress}
      {...button()}
    >
      <Text style={buttonText()}>{props.label}</Text>
    </View>
  );
}

const colors = () => [ui().accent, ui().info, ui().violet, ui().down, ui().warn];

function App() {
  const messages = signal<string[]>([]);
  const nav = signal<WebViewNavigation | null>(null);
  const sent = signal(0);
  let painted = 0;
  let web!: YNode;
  const wide = () => windowSize().width >= 700;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>web-view</Text>
      <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 16 }}>
        <WebView
          ref={web}
          html={page(ui())}
          // Runs after each load: the page reports its title.
          injectedJavaScript={`window.nsh.postMessage("loaded: " + document.title)`}
          onLoad={(e) => nav.set(e)}
          onMessage={(e) => messages.set([e.data, ...messages()].slice(0, 4))}
          style={{ flex: 1, minHeight: 240, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: ui().border }}
        />
        <View style={{ gap: 12, width: wide() ? 320 : undefined }}>
          <Text style={{ color: ui().muted }}>
            {platform.idiom === "desktop" ? "Click" : "Tap"} the button in the page to post to the app; these buttons call the ref's methods.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              label="postMessage"
              onPress={() => {
                sent.update((n) => n + 1);
                web.postMessage(`hello #${sent()}`);
              }}
            />
            <Button
              label="injectJavaScript"
              onPress={() => {
                const color = colors()[painted++ % colors().length];
                web.injectJavaScript(`document.getElementById("box").style.background = "${color}"`);
              }}
            />
            <Button label="reload" onPress={() => web.reload()} />
          </View>
          <View style={{ ...ui().card, borderRadius: 12, padding: 12, gap: 4 }}>
            <Text style={{ color: ui().muted, fontSize: 12 }}>onLoad</Text>
            <Text style={{ color: ui().text, fontFamily: "monospace", fontSize: 13 }} numberOfLines={1}>
              {nav() ? `title "${nav()!.title}"` : "…"}
            </Text>
            <Text style={{ color: ui().muted, fontSize: 12, marginTop: 6 }}>onMessage, newest first</Text>
            <Each of={messages()}>
              {(m) => <Text style={{ color: ui().text, fontFamily: "monospace", fontSize: 13 }}>{m()}</Text>}
            </Each>
          </View>
        </View>
      </View>
    </View>
  );
}

mount(App);
