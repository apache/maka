// A case of the API's test suite (docs/dev/compatibility.md):
// `Speech` on the headless runtime, where nothing recognizes speech:
// `available()` resolves false, and a session `start` returns ends at once
// with `error: "unavailable"` (its `end` listener gets it; `start` and
// `result` never come). Options of the wrong kind throw: a `lang` that is
// no language tag a `RangeError`. Its script checks each.
import { Text, View, signal } from "nsh";
import { Speech, type SpeechSession } from "nsh";

function App() {
  const available = signal("unknown");
  const heard = signal("not started");
  const refused = signal("none");
  Speech.available().then((yes: boolean) => available.set(String(yes)));
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Available: ${available()}`}</Text>
      <Text>{`Speech: ${heard()}`}</Text>
      <Text>{`Refused: ${refused()}`}</Text>
      <View
        testID="start"
        onPress={() => {
          try {
            Speech.start({ lang: "not a tag" });
          } catch (e) {
            refused.set(`threw ${(e as Error).name}`);
          }
          const session: SpeechSession = Speech.start({ lang: "en-US", interim: true });
          heard.set("started");
          session.on("start", () => heard.set("listening"));
          session.on("result", ({ text, isFinal }) => heard.set(`${isFinal ? "final" : "interim"} ${text}`));
          session.on("end", ({ text, error }) => {
            heard.set(`end ${error ?? "ok"} "${text}" ${session.ended}`);
          });
        }}
      >
        <Text>Start</Text>
      </View>
    </View>
  );
}

export default App;
