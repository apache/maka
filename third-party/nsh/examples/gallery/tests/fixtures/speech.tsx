// Dictation: the button starts a speech session (and stops the one
// listening); the transcript shows as it grows, then how the session ended.
import { mount, signal, Speech, type SpeechSession, Text, View } from "nsh";

function App() {
  const state = signal("idle");
  const transcript = signal("");
  let session: SpeechSession | undefined;
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
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

mount(App);
