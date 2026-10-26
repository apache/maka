// A case of the API's test suite (docs/dev/compatibility.md): how a video
// plays, as the platform receives it: its source, paused (then playing),
// muted, its volume and speed, looping, the platform's controls, how it
// fits its box, how often it reports progress and what its sound does to
// other apps' audio. Its script checks each.
import { Text, View, signal } from "nsh";
import { Video } from "nsh/video";

function App() {
  const paused = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View testID="play" onPress={() => paused.set(false)}>
        <Text>Play</Text>
      </View>
      <Video
        testID="clip"
        src="https://example.com/clip.mp4"
        paused={paused()}
        muted
        volume={0.25}
        rate={1.5}
        repeat
        controls
        resizeMode="cover"
        progressUpdateInterval={500}
        audioSession="playback"
        style={{ width: 160, height: 90 }}
      />
    </View>
  );
}

export default App;
