// Web views with and without `scrollable`: each page reports, after a drag over it, whether its own
// touch handlers heard the moves and whether its viewport scrolled.
import { mount, signal, Text, View, WebView } from "nsh";

const page = (name: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;font:16px sans-serif">${Array.from({ length: 60 }, (_, i) => `<p style="height:40px;margin:0">Row ${i}</p>`).join("")}
<script>
let moves = 0;
addEventListener("load", () => window.nsh.postMessage("${name} ready"));
addEventListener("touchmove", () => moves++, { passive: true });
addEventListener("touchend", () => setTimeout(() => window.nsh.postMessage(
  "${name} " + (moves > 0 ? "moved" : "still") + " " + (scrollY > 0 ? "scrolled" : "unscrolled")), 500));
</script></body></html>`;

function Page(props: { name: string; scrollable: boolean }) {
  const said = signal("");
  return (
    <View style={{ gap: 4 }}>
      <Text>{said()}</Text>
      <View testID={props.name} style={{ height: 280 }}>
        <WebView html={page(props.name)} scrollable={props.scrollable} style={{ flex: 1 }} onMessage={(e) => said.set(e.data)} />
      </View>
    </View>
  );
}

mount(() => (
  <View style={{ flex: 1, paddingTop: 40, gap: 12 }}>
    <Page name="fixed" scrollable={false} />
    <Page name="scrolling" scrollable />
  </View>
));
