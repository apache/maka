// The desktop domain of the API's test apps (docs/dev/compatibility.md):
// windows of the app's own and the tray, run as on macOS (`platform macos`),
// with a `windows` capability that grants four kinds and three windows at
// once.
// Each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import TrayClick from "./tray-click";
import WindowAccess from "./window-access";
import WindowElement from "./window-element";
import WindowOpen from "./window-open";
import WindowProps from "./window-props";
import WindowRef from "./window-ref";
import LinkHover from "./link-hover";

const cases: Record<string, () => JSX.Element> = {
  "link-hover": LinkHover,
  "window-open": WindowOpen,
  "window-element": WindowElement,
  "window-ref": WindowRef,
  "window-access": WindowAccess,
  "window-props": WindowProps,
  "tray-click": TrayClick,
};
const shown = signal("");

mount(() => (
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
));
