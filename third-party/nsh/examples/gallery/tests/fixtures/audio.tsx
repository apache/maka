// Sound: a click loaded ahead and played on press (and refused with a
// volume out of range), and a voice message streamed by a player, whose
// state and position show.
import { AudioPlayer, mount, signal, Sound, Text, View } from "nsh";

/// A WAV file of `ms` milliseconds of silence (8 kHz, 16-bit mono).
function silenceBytes(ms: number): Uint8Array {
  const data = ms * 16;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data, true);
  return bytes;
}

/// The same, as a percent-encoded `data:` URI.
function silence(ms: number): string {
  const bytes = silenceBytes(ms);
  return `data:audio/wav,${Array.from(bytes, b => `%${b.toString(16).padStart(2, "0")}`).join("")}`;
}

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.label} onPress={props.onPress} style={{ height: 40 }}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  const sound = signal("none");
  const refused = signal("none");
  const player = signal("idle");
  let click: Sound | undefined;
  let ticks: Sound[] = [];
  const voice = new AudioPlayer("https://example.com/voice.m4a", { volume: 0.8 });
  voice.on("load", ({ duration }) => player.set(`loaded ${duration}`));
  voice.on("end", () => player.set(`ended at ${voice.currentTime}`));
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text>{`sound: ${sound()}`}</Text>
      <Text>{`refused: ${refused()}`}</Text>
      <Text>{`player: ${player()}`}</Text>
      <Button
        label="Load"
        onPress={() => {
          Sound.load(silence(250)).then(
            loaded => {
              click = loaded;
              sound.set(`${loaded.duration}s`);
            },
            (e: Error & { code?: string }) => sound.set(`failed ${e.code}`),
          );
        }}
      />
      <Button label="Load long" onPress={() => {
        Sound.load(silence(6000)).catch((e: Error & { code?: string }) => sound.set(`failed ${e.code}`));
      }} />
      <Button
        label="Play bytes"
        onPress={() => {
          // Equal bytes share one sound: loaded once, each play a voice.
          Promise.all([Sound.load(silenceBytes(100)), Sound.load(silenceBytes(100))]).then(([a, b]) => {
            ticks = [a, b];
            a.play();
            b.play({ volume: 0.3 });
            sound.set(`bytes ${a.duration}s`);
          });
        }}
      />
      <Button label="Stop bytes" onPress={() => ticks.forEach(tick => tick.stop())} />
      <Button
        label="Play"
        onPress={() => {
          click?.play({ volume: 0.5 });
          try {
            click?.play({ volume: 2 });
          } catch (e) {
            refused.set((e as Error).name);
          }
        }}
      />
      <Button
        label="Listen"
        onPress={() => {
          voice.play().then(() => player.set(`${voice.state} ${voice.duration}`));
        }}
      />
      <Button
        label="Skip"
        onPress={() => {
          voice.seek(30);
          try {
            voice.seek(1e30);
          } catch (e) {
            refused.set(`seek ${(e as Error).name}`);
          }
        }}
      />
      <Button label="Pause" onPress={() => voice.pause()} />
    </View>
  );
}

mount(() => <App />);
