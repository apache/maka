// A case of the API's test suite (docs/dev/compatibility.md): `nsh/updater`
// in a run that is no packaged app (the compat runner): nothing to update
// from, so the checks resolve `null`, a channel's included, the code ran from no package, and
// downloading or restarting into a package, or installing an update as the
// app quits, rejects; the built-in prompt has nothing to ask and resolves; the shell has no packaged
// version but says which NSH runs it. Its script checks them.
import { Text, View, signal } from "nsh";
import {
  checkForPackage,
  checkForUpdate,
  downloadPackage,
  installOnQuit,
  promptForUpdate,
  restartToPackage,
  runningPackage,
  shellInfo,
} from "nsh/updater";

function App() {
  const update = signal("pending");
  const check = signal("pending");
  const download = signal("pending");
  const restart = signal("pending");
  const onQuit = signal("pending");
  const prompt = signal("pending");
  const running = runningPackage();
  const shell = shellInfo();
  checkForUpdate({ channel: "beta" }).then(
    (found) => update.set(found === null ? "null" : found.version),
    () => update.set("rejected"),
  );
  checkForPackage().then(
    (found) => check.set(found === null ? "null" : `build ${found.build}`),
    () => check.set("rejected"),
  );
  downloadPackage(() => {}).then(
    () => download.set("resolved"),
    () => download.set("rejected"),
  );
  restartToPackage().then(
    () => restart.set("resolved"),
    () => restart.set("rejected"),
  );
  installOnQuit().then(
    () => onQuit.set("resolved"),
    () => onQuit.set("rejected"),
  );
  promptForUpdate({ quiet: true }).then(
    () => prompt.set("resolved"),
    () => prompt.set("rejected"),
  );
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Running package: ${running === null ? "none" : running.build}`}</Text>
      <Text>{`Shell: ${shell.version ?? "none"} build ${shell.build ?? "none"}, packages ${shell.packages}`}</Text>
      <Text>{`NSH version: ${/^\d+\.\d+\.\d+/.test(shell.nshVersion) ? "semver" : shell.nshVersion}`}</Text>
      <Text>{`Update: ${update()}`}</Text>
      <Text>{`Check: ${check()}`}</Text>
      <Text>{`Download: ${download()}`}</Text>
      <Text>{`Restart: ${restart()}`}</Text>
      <Text>{`Install on quit: ${onQuit()}`}</Text>
      <Text>{`Prompt: ${prompt()}`}</Text>
    </View>
  );
}

export default App;
