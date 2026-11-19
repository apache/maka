// A case of the API's test suite (docs/dev/compatibility.md): this domain
// declares capabilities without `application`, so what acts on the
// application as a whole is refused: the main window's commands
// (`nsh/desktop`'s `WindowRef`) reach nothing (asked to minimize, the window
// stays as it was; headless, no platform reports, so `state()` stays
// undefined), and turning launching at login on rejects with
// `ERR_ACCESS_DENIED`. Its script checks the state the window reports and
// the rejection.
import { Text, View, signal } from "nsh";
import { Application, currentWindow } from "nsh/desktop";

export default function ApplicationRefused() {
  const win = currentWindow();
  win.minimize();
  const login = signal("not set");
  Application.setLaunchAtLogin(true).then(
    () => login.set("resolved"),
    (error) => login.set(`${error?.code} ${error?.permission}`),
  );
  return (
    <View>
      <Text>{() => `Minimized: ${win.state()?.minimized ?? "unknown"}`}</Text>
      <Text>{`Launch at login: ${login()}`}</Text>
    </View>
  );
}
