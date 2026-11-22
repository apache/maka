import { mount, signal, Text, Video, type VideoRef, View } from "nsh";
import { windowSize } from "nsh";
import { Button, Toggle } from "nsh/base";
import { button, buttonText, toggleLabel, toggleLook, ui } from "./palette";

// A short CC0 clip from MDN's examples.
const FLOWER = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

/** The look of a video option: a small toggle with a label, on a field's edge while off. */
const option = { size: "small", variant: "outline", text: true } as const;

/** A video option that is on or off: a `Toggle`, the on fill while on. */
function Option(props: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Toggle pressed={props.on} onChange={({ pressed }) => props.onChange(pressed)} {...toggleLook(option)}>
      <Text style={toggleLabel(() => props.on, option)}>{props.label}</Text>
    </Toggle>
  );
}

/** A command to the video (play or pause, seek): a `Button`. */
function Action(props: { label: string; onPress: () => void }) {
  return (
    <Button onPress={props.onPress} {...button("secondary", { size: "sm" })}>
      <Text style={buttonText("secondary", { size: "sm" })}>{props.label}</Text>
    </Button>
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
  let video!: VideoRef;

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
          {/* The commands, then the options: a raised button and an option
              that is on are both filled, so each kind keeps a row of its own. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action label={paused() ? "Play" : "Pause"} onPress={() => paused.set(!paused())} />
            <Action label="seek(0)" onPress={() => video.seek(0)} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Option label="muted" on={muted()} onChange={(on) => muted.set(on)} />
            <Option label="repeat" on={repeat()} onChange={(on) => repeat.set(on)} />
            <Option label="rate 2" on={fast()} onChange={(on) => fast.set(on)} />
            <Option label="controls" on={controls()} onChange={(on) => controls.set(on)} />
          </View>
        </View>
      </View>
    </View>
  );
}

mount(App);
