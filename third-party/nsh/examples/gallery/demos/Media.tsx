import { signal, Text, Video, type VideoRef, View, WebView, type WebViewNavigation, type WebViewRef } from "nsh";
import { Icon } from "../icons";
import { Badge, Button, Caption, Card, colors, DemoPage, finish, isDark, Meter, Press, radius, RoundButton, Segmented } from "../ui";

/** An inline page in the gallery's colors (for the appearance shown: the page reloads when it changes). */
const page = () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; padding: 16px; background: ${colors.inset}; color: ${colors.text}; font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.4; }
  h3 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
  p { margin: 0 0 12px; color: ${colors.muted}; font-size: 15px; }
  button { height: 44px; padding: 0 18px; border: 0; border-radius: 10px; background: ${finish.accent.backgroundImage}; color: ${colors.onAccent}; font-family: inherit; font-size: 15px; font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,${isDark() ? 0.45 : 0.6}); }
  #got { margin-top: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid ${colors.border}; color: ${colors.muted}; font-size: 15px; }
</style></head>
<body>
<h3>An inline page</h3>
<p>HTML from a string. It sends messages to the app and receives them.</p>
<button onclick="window.nsh.postMessage('hello from the page')">Post to the app</button>
<div id="got">No message from the app yet.</div>
<script>window.addEventListener('message', (e) => { document.getElementById('got').textContent = 'From the app: ' + e.data; });</script>
</body></html>`;

const frame = () => ({ borderRadius: radius.control, overflow: "hidden", borderWidth: 1, borderColor: colors.border }) as const;

function Messaging() {
  const message = signal("");
  const sent = signal(0);
  let web!: WebViewRef;
  return (
    <Card icon="media" title="Web view" subtitle="Inline HTML, with messages both ways">
      <WebView ref={web} html={page()} style={{ height: 210, backgroundColor: colors.inset, ...frame() }} onMessage={(e) => message.set(e.data)} />
      <Caption label="From the page" note={message() || "—"} />
      <Caption label="To the page" note={sent() ? `hi #${sent()}` : "—"} />
      <Button
        label="Post to the page"
        onPress={() => {
          sent.set(Math.round(performance.now()) % 1000);
          web.postMessage(`hi #${sent()}`);
        }}
      />
    </Card>
  );
}

/** A round icon button, 44 pt. */
function NavButton(props: { flip?: boolean; enabled: boolean; label: string; onPress: () => void }) {
  return (
    <Press
      onPress={props.onPress}
      disabled={!props.enabled}
      accessibilityLabel={props.label}
      hitSlop={4}
      hoverStyle={finish.hover}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        borderWidth: 1,
        ...finish.raised,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={{ transform: props.flip ? "rotate(180deg)" : "none" }}>
        <Icon name="chevron" size={18} tint={colors.text} />
      </View>
    </Press>
  );
}

function Site() {
  const state = signal<WebViewNavigation | null>(null);
  let site!: WebViewRef;
  const host = () => {
    const url = state()?.url ?? "";
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "…";
  };
  return (
    <Card
      icon="search"
      title="A web site"
      subtitle={state()?.title || "Navigation state, back and forward"}
      right={<Badge label={state()?.loading ? "Loading" : "Loaded"} tone={state()?.loading ? "warn" : "up"} />}
    >
      <View
        style={{
          height: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 14,
          borderRadius: 20,
          backgroundColor: colors.inset,
          ...finish.track,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: state()?.loading ? colors.warn : colors.up }} />
        <Text style={{ numberOfLines: 1, textOverflow: "ellipsis-middle", flex: 1, fontSize: 15, color: colors.muted }}>
          {host()}
        </Text>
      </View>
      <WebView
        ref={site}
        src="https://nsh.dev"
        style={{ height: 340, backgroundColor: colors.inset, ...frame() }}
        onNavigationStateChange={(v) => state.set(v)}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <NavButton flip label="Back" enabled={!!state()?.canGoBack} onPress={() => site.goBack()} />
        <NavButton label="Forward" enabled={!!state()?.canGoForward} onPress={() => site.goForward()} />
        <View style={{ flex: 1 }} />
        <Button label="Reload" variant="secondary" onPress={() => site.reload()} />
      </View>
    </Card>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function Player() {
  const controls = signal<"own" | "system">("own");
  const paused = signal(true);
  const time = signal(0);
  const duration = signal(0);
  const buffering = signal(false);
  const failed = signal(false);
  let video!: VideoRef;
  return (
    <Card
      icon="play"
      title="Video"
      subtitle="AVPlayer / MediaPlayer"
      right={
        <Badge
          label={failed() ? "Error" : buffering() ? "Buffering" : paused() ? "Paused" : "Playing"}
          tone={failed() ? "danger" : buffering() ? "warn" : paused() ? "neutral" : "accent"}
        />
      }
    >
      <Video
        ref={video}
        src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
        paused={paused()}
        muted
        repeat
        controls={controls() === "system"}
        style={{ height: 200, backgroundColor: "#000000", ...frame() }}
        onLoad={(e) => duration.set(e.duration)}
        onError={() => failed.set(true)}
        onBuffer={(e) => buffering.set(e.isBuffering)}
        onProgress={(e) => {
          time.set(e.currentTime);
          duration.set(e.duration);
        }}
      />
      <If when={controls() === "own"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <RoundButton icon={paused() ? "play" : "pause"} label={paused() ? "Play" : "Pause"} onPress={() => paused.set(!paused())} />
          <View style={{ flex: 1, gap: 8 }}>
            <Meter value={duration() > 0 ? time() / duration() : 0} />
            <View style={{ flexDirection: "row" }}>
              <Text style={{ flex: 1, fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{fmt(time())}</Text>
              <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{fmt(duration())}</Text>
            </View>
          </View>
          <Button label="Restart" variant="secondary" onPress={() => video.seek(0)} />
        </View>
      </If>
      <Segmented
        options={[
          { value: "own", label: "Own controls" },
          { value: "system", label: "System controls" },
        ]}
        value={controls()}
        onChange={(v) => controls.set(v)}
      />
    </Card>
  );
}

export function Media() {
  const cards = [Messaging, Site, Player];
  return <DemoPage cards={cards} />;
}
