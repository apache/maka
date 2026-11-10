// The macos domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import BaseDock from "./base-dock";
import ModAccessDenied from "./mod-access-denied";
import ModKeymapPass from "./mod-keymap-pass";
import DesktopProps from "./desktop-props";
import ModStandardSystem from "./mod-standard-system";
import ModStandardFiles from "./mod-standard-files";
import WebSendInput from "./web-send-input";
import MaterialComposition from "./material-composition";

const cases: Record<string, () => JSX.Element> = {
  "base-dock": BaseDock,
  "desktop-props": DesktopProps,
  "mod-standard-system": ModStandardSystem,
  "mod-standard-files": ModStandardFiles,
  "mod-access-denied": ModAccessDenied,
  "mod-keymap-pass": ModKeymapPass,
  "web-send-input": WebSendInput,
  "material-composition": MaterialComposition,
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
