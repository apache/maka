// A 3-second clip (`clip.mp4`, the macOS host tests' own) played by the
// browser's `<video>`, with the buttons apps drive a video with.
// `App.test.tsx` runs it in Chrome (`nsh test crates/nsh-platform-web/tests/video --target web`).
import { mount, signal, Text, Video, type VideoRef, View } from "nsh";
import { Button } from "nsh/base";

function App() {
  let video!: VideoRef;
  const paused = signal(true);
  const pauseAtEnd = signal(true);
  const volume = signal(1);
  const shown = signal(true);
  const duration = signal<number | null>(null);
  const time = signal(0);
  const ends = signal(0);
  // One element, taken out of the page and put back: removed, not deleted.
  const player = (
    <Video
      ref={video}
      src="asset:/clip.mp4"
      paused={paused()}
      muted
      volume={volume()}
      style={{ width: 160, height: 160, backgroundColor: "#000000" }}
      onLoad={(e) => duration.set(e.duration)}
      onProgress={(e) => time.set(e.currentTime)}
      onEnd={() => {
        ends.set(ends() + 1);
        if (pauseAtEnd()) paused.set(true);
      }}
    />
  );
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <View style={{ width: 160, height: 160 }}>{shown() ? player : null}</View>
      <Text>{`Duration: ${duration()?.toFixed(1) ?? "none"}`}</Text>
      <Text>{`Time: ${time().toFixed(1)}`}</Text>
      <Text>{`Ends: ${ends()}`}</Text>
      <Button onPress={() => paused.set(false)} style={{ minHeight: 44 }}>
        <Text>Play</Text>
      </Button>
      <Button onPress={() => video.seek(0)} style={{ minHeight: 44 }}>
        <Text>Seek to start</Text>
      </Button>
      <Button onPress={() => volume.set(volume() === 1 ? 0.5 : 1)} style={{ minHeight: 44 }}>
        <Text>{`Volume ${volume()}`}</Text>
      </Button>
      <Button onPress={() => pauseAtEnd.set(false)} style={{ minHeight: 44 }}>
        <Text>{pauseAtEnd() ? "Keep playing at end" : "Keeps playing at end"}</Text>
      </Button>
      <Button onPress={() => shown.set(!shown())} style={{ minHeight: 44 }}>
        <Text>{shown() ? "Take out" : "Put back"}</Text>
      </Button>
    </View>
  );
}

mount(App);
