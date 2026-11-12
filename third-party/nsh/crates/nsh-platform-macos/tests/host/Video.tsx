// A 3-second clip (`clip.mp4`) played by AVPlayer, with the buttons apps
// restart a video with. `Video.test.tsx` runs it on the macOS host.
// clip.mp4: `ffmpeg -f lavfi -i testsrc=duration=3:size=64x64:rate=10 -c:v libx264 -profile:v baseline -pix_fmt yuv420p clip.mp4`
import { mount, signal, Text, Video, type VideoRef, View } from "nsh";
import { Button } from "nsh/base";

function App() {
  let video!: VideoRef;
  const paused = signal(true);
  const pauseAtEnd = signal(true);
  const duration = signal<number | null>(null);
  const time = signal(0);
  const ends = signal(0);
  const run = signal<number | null>(null);
  let started = 0;
  const start = () => {
    started = Date.now();
    run.set(null);
  };
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Video
        ref={video}
        src="asset:/clip.mp4"
        paused={paused()}
        muted
        style={{ width: 160, height: 160, backgroundColor: "#000000" }}
        onLoad={(e) => duration.set(e.duration)}
        onProgress={(e) => time.set(e.currentTime)}
        onEnd={() => {
          ends.set(ends() + 1);
          run.set(Date.now() - started);
          if (pauseAtEnd()) paused.set(true);
        }}
      />
      <Text>{`Duration: ${duration()?.toFixed(1) ?? "none"}`}</Text>
      <Text>{`Time: ${time().toFixed(1)}`}</Text>
      <Text>{`Ends: ${ends()}`}</Text>
      <Text>{`Run: ${run() ?? "none"}`}</Text>
      <Button
        onPress={() => {
          start();
          paused.set(false);
        }}
        style={{ minHeight: 44 }}
      >
        <Text>Play</Text>
      </Button>
      <Button
        onPress={() => {
          start();
          video.seek(0);
          paused.set(false);
        }}
        style={{ minHeight: 44 }}
      >
        <Text>Restart</Text>
      </Button>
      <Button
        onPress={() => {
          start();
          video.seek(0);
        }}
        style={{ minHeight: 44 }}
      >
        <Text>Seek to start</Text>
      </Button>
      <Button onPress={() => pauseAtEnd.set(false)} style={{ minHeight: 44 }}>
        <Text>{pauseAtEnd() ? "Keep playing at end" : "Keeps playing at end"}</Text>
      </Button>
    </View>
  );
}

mount(App);
