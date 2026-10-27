import { mount, signal, Text, Video, View, type YNode } from "nsh";
import { windowSize } from "nsh";
import { button, buttonText, ui } from "./palette";

// A short CC0 clip from MDN's examples.
const FLOWER = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

function Toggle(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <View
      onPress={props.onPress}
      {...button("secondary", { on: () => props.on, size: "sm" })}
    >
      <Text style={buttonText("secondary", { on: () => props.on })}>{props.label}</Text>
    </View>
  );
}

function App() {
  const paused = signal(true);
  const muted = signal(true);
  const repeat = signal(true);
  const controls = signal(false);
  const fast = signal(false);
  const time = signal(0);
  const duration = signal(0);
  const ratio = signal(16 / 9);
  const status = signal("loading");
  const ends = signal(0);
  let video!: YNode;

  const wide = () => windowSize().width >= 700;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>video</Text>
      <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 16 }}>
        <View style={{ flex: wide() ? 1 : undefined, justifyContent: "center" }}>
          <Video
            ref={video}
            src={FLOWER}
            paused={paused()}
            muted={muted()}
            repeat={repeat()}
            controls={controls()}
            rate={fast() ? 2 : 1}
            resizeMode="contain"
            progressUpdateInterval={100}
            style={{ width: "100%", aspectRatio: ratio(), borderRadius: 14, overflow: "hidden", backgroundColor: "#000000" }}
            onLoadStart={() => status.set("onLoadStart")}
            onLoad={(e) => {
              duration.set(e.duration);
              ratio.set(e.size.width / e.size.height);
              status.set(`onLoad ${e.size.width} × ${e.size.height}`);
            }}
            onProgress={(e) => time.set(e.currentTime)}
            onBuffer={(e) => status.set(e.isBuffering ? "buffering" : "playing")}
            onEnd={() => ends.update((n) => n + 1)}
            onError={(e) => status.set(`onError ${e.message}`)}
          />
        </View>

        <View style={{ gap: 12, width: wide() ? 300 : undefined, justifyContent: "center" }}>
          <View style={{ ...ui().inset, height: 6, borderRadius: 3, overflow: "hidden" }}>
            <View style={{ height: 6, width: `${duration() ? (time() / duration()) * 100 : 0}%`, backgroundColor: ui().accent }} />
          </View>
          <Text style={{ color: ui().text, fontFamily: "monospace" }}>
            onProgress {time().toFixed(1)} / {duration().toFixed(1)} s
          </Text>
          <Text style={{ color: ui().muted, fontFamily: "monospace", fontSize: 13 }}>
            {status()} · onEnd {ends()}×
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Toggle label={paused() ? "Play" : "Pause"} on={!paused()} onPress={() => paused.set(!paused())} />
            <Toggle label="muted" on={muted()} onPress={() => muted.set(!muted())} />
            <Toggle label="repeat" on={repeat()} onPress={() => repeat.set(!repeat())} />
            <Toggle label="rate 2" on={fast()} onPress={() => fast.set(!fast())} />
            <Toggle label="controls" on={controls()} onPress={() => controls.set(!controls())} />
            <Toggle label="seek(0)" on={false} onPress={() => video.seek(0)} />
          </View>
        </View>
      </View>
    </View>
  );
}

mount(App);
