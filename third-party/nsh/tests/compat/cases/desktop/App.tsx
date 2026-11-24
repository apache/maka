// The desktop domain of the API's test apps (docs/dev/compatibility.md):
// windows of the app's own, the tray and launching at login, run as on macOS
// (`platform macos`), with a `windows` capability that grants four kinds and
// four windows at once, the open ones included.
// Each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import { Window } from "nsh/desktop";
import TrayClick from "./tray-click";
import WindowAccess from "./window-access";
import WindowElement from "./window-element";
import WindowOpen from "./window-open";
import WindowProps from "./window-props";
import WindowRef from "./window-ref";
import LinkHover from "./link-hover";
import HomeDirAccess from "./home-dir-access";
import LaunchAtLogin from "./launch-at-login";
import ScrollbarHover from "./scrollbar-hover";

const cases: Record<string, () => JSX.Element> = {
  "link-hover": LinkHover,
  "scrollbar-hover": ScrollbarHover,
  "window-open": WindowOpen,
  "window-element": WindowElement,
  "window-ref": WindowRef,
  "window-access": WindowAccess,
  "window-props": WindowProps,
  "tray-click": TrayClick,
  "home-dir-access": HomeDirAccess,
  "launch-at-login": LaunchAtLogin,
};
const shown = signal("");

mount(() => <Window id="main">{() => (
  <>
    {() => {
      const Case = cases[shown()];
      return Case ? <Case /> : null;
    }}
    <View style={{ position: "absolute", left: 0, top: 0, flexDirection: "row" }}>
      {Object.keys(cases).map(name => (
        <View testID={`case-${name}`} style={{ width: 1, height: 1 }} onPress={() => shown.set(name)} />
      ))}
    </View>
  </>
)}</Window>);
