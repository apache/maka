// A case of the API's test suite (docs/dev/compatibility.md): `nsh/updater`
// in a run that is no packaged app (the compat runner): nothing to update
// from, so the checks resolve `null`, the code ran from no package, and
// downloading or restarting into a package rejects; the shell has no packaged
// version but says which NSH runs it. Its script checks them.
import { Text, View, signal } from "nsh";
import { checkForPackage, downloadPackage, restartToPackage, runningPackage, shellInfo } from "nsh/updater";

function App() {
  const check = signal("pending");
  const download = signal("pending");
  const restart = signal("pending");
  const running = runningPackage();
  const shell = shellInfo();
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
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`Running package: ${running === null ? "none" : running.build}`}</Text>
      <Text>{`Shell: ${shell.version ?? "none"} build ${shell.build ?? "none"}, packages ${shell.packages}`}</Text>
      <Text>{`NSH version: ${/^\d+\.\d+\.\d+/.test(shell.nshVersion) ? "semver" : shell.nshVersion}`}</Text>
      <Text>{`Check: ${check()}`}</Text>
      <Text>{`Download: ${download()}`}</Text>
      <Text>{`Restart: ${restart()}`}</Text>
    </View>
  );
}

export default App;
