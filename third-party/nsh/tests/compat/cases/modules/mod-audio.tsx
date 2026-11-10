// A case of the API's test suite (docs/dev/compatibility.md):
// `Sound` and `AudioPlayer` on the headless runtime, where nothing plays
// sound: `available()` resolves false, `Sound.load` rejects with
// ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, and a player's `play()` rejects as
// its `error` listener hears `unavailable`. Values out of range throw a
// `RangeError` in the call. An imported audio file is its `asset:/` URL.
// Its script checks each.
import { Text, View, signal } from "nsh";
import { AudioPlayer, Sound } from "nsh";
import click from "./sounds/click.wav";

function App() {
  const available = signal("unknown");
  const loaded = signal("not loaded");
  const played = signal("not played");
  const refused = signal("none");
  Sound.available().then((yes: boolean) => available.set(String(yes)));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Available: ${available()}`}</Text>
      <Text>{`Sound: ${loaded()}`}</Text>
      <Text>{`Player: ${played()}`}</Text>
      <Text>{`Refused: ${refused()}`}</Text>
      <Text>{`Imported: ${click}`}</Text>
      <View
        testID="play"
        onPress={() => {
          try {
            new AudioPlayer("voice.m4a", { volume: 2 });
          } catch (e) {
            refused.set(`threw ${(e as Error).name}`);
          }
          Sound.load(click).then(
            (sound: Sound) => loaded.set(`loaded ${sound.duration}`),
            (e: Error & { code?: string }) => loaded.set(`rejected ${e.code}`),
          );
          const player = new AudioPlayer("voice.m4a", { loop: true, rate: 1.5 });
          let heard = "no error";
          player.on("error", ({ code }) => {
            heard = `error ${code}`;
          });
          player.play().then(
            () => played.set("playing"),
            () => played.set(`rejected, ${heard}, ${player.state} ${player.loop} ${player.rate}`),
          );
        }}
      >
        <Text>Play</Text>
      </View>
    </View>
  );
}

export default App;
