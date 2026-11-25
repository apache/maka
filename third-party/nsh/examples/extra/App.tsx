// The modules of `nsh-extra`, the official modules an app installs with
// `nsh add` (`nsh.json` `"dependencies"`), one feature each. Dictation with
// `Speech`: the button starts a session (and stops the one listening); the
// transcript shows as it grows, then how the session ended.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Speech, type SpeechSession } from "nsh-extra";

function Dictation() {
  const state = signal("idle");
  const transcript = signal("");
  let session: SpeechSession | undefined;
  return (
    <View style={{ flex: 1, gap: 12, padding: 24, paddingTop: 80 }}>
      <Text>{`state: ${state()}`}</Text>
      <Text>{`transcript: ${transcript()}`}</Text>
      <View
        role="button"
        accessibilityLabel="Dictate"
        onPress={() => {
          if (session && !session.ended) {
            session.stop();
            return;
          }
          session = Speech.start({ lang: "zh-CN" });
          state.set("starting");
          session.on("start", () => state.set("listening"));
          session.on("result", ({ text, isFinal }) => {
            transcript.set(text);
            if (isFinal) state.set("final");
          });
          session.on("end", ({ error }) => state.set(error ? `ended ${error}` : "ended"));
        }}
      >
        <Text>Dictate</Text>
      </View>
      <View role="button" accessibilityLabel="Cancel" onPress={() => session?.abort()}>
        <Text>Cancel</Text>
      </View>
    </View>
  );
}

mount(() => <Window id="main">{Dictation}</Window>);
