// The modules of `nsh-extra`, the official modules an app installs with
// `nsh add` (`nsh.json` `"dependencies"`), one feature each.
//
// Dictation with `Speech`: the button starts a session (and stops the one
// listening); the transcript shows as it grows, then how the session ended.
//
// The system's share sheet with `Share`: a link, a file of the app's data
// directory and a line of text, each pointing the sheet at its button (an
// iPad's popover, macOS' menu); how the share ended shows below.
import fs from "fs/promises";
import process from "process";
import { mount, signal, Text, View, type ViewRef } from "nsh";
import { Window } from "nsh/desktop";
import { Share, type ShareResult, Speech, type SpeechSession } from "nsh-extra";

function Dictation() {
  const state = signal("idle");
  const transcript = signal("");
  let session: SpeechSession | undefined;
  return (
    <View style={{ gap: 12 }}>
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

const TRIP = {
  title: "Weekend in Kyoto",
  text: "Our plan for the weekend: temples in the morning, the market at noon.",
  url: "https://example.com/trips/kyoto",
};

function Sharing() {
  const available = signal("checking");
  void Share.available().then((yes) => available.set(yes ? "yes" : "no"));
  const shared = signal("none");
  // How the share ended, or the code of why there was none.
  const report = async (share: () => Promise<ShareResult>) => {
    try {
      const { action, target } = await share();
      shared.set(target ? `${action} ${target}` : action);
    } catch (e) {
      const error = e as Error & { code?: string };
      shared.set(error.code ?? error.message);
    }
  };
  let link: ViewRef | undefined;
  let file: ViewRef | undefined;
  let line: ViewRef | undefined;
  return (
    <View style={{ gap: 12 }}>
      <Text>{`share sheet: ${available()}`}</Text>
      <Text>{`shared: ${shared()}`}</Text>
      <View
        ref={link}
        role="button"
        accessibilityLabel="Share link"
        onPress={() => void report(() => Share.show({ ...TRIP, anchor: link }))}
      >
        <Text>Share link</Text>
      </View>
      <View
        ref={file}
        role="button"
        accessibilityLabel="Share file"
        onPress={() =>
          void report(async () => {
            if (!process.dataDir) throw new Error("this host gives the app no data directory");
            const path = `${process.dataDir}/kyoto-itinerary.txt`;
            await fs.writeFile(path, `${TRIP.title}\n\nSaturday: Fushimi Inari\nSunday: Arashiyama\n`);
            return Share.show({ title: TRIP.title, files: [path], anchor: file });
          })
        }
      >
        <Text>Share file</Text>
      </View>
      <View
        ref={line}
        role="button"
        accessibilityLabel="Share text"
        onPress={() => void report(() => Share.show({ text: TRIP.text, anchor: line }))}
      >
        <Text>Share text</Text>
      </View>
    </View>
  );
}

function Main() {
  return (
    <View style={{ flex: 1, gap: 32, padding: 24, paddingTop: 80 }}>
      <Dictation />
      <Sharing />
    </View>
  );
}

mount(() => <Window id="main">{Main}</Window>);
