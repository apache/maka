// The modules domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import ModStandardAccess from "./mod-standard-access";
import ModAccessibility from "./mod-accessibility";
import ModAndroid from "./mod-android";
import ModClipboard from "./mod-clipboard";
import ModDesktop from "./mod-desktop";
import ModDevice from "./mod-device";
import ModHost from "./mod-host";
import ModHostChannel from "./mod-host-channel";
import ModIos from "./mod-ios";
import ModKeymap from "./mod-keymap";
import ModMobile from "./mod-mobile";
import ModPicker from "./mod-picker";
import ModStorage from "./mod-storage";

const cases: Record<string, () => JSX.Element> = {
  "mod-standard-access": ModStandardAccess,
  "mod-accessibility": ModAccessibility,
  "mod-android": ModAndroid,
  "mod-clipboard": ModClipboard,
  "mod-desktop": ModDesktop,
  "mod-device": ModDevice,
  "mod-host": ModHost,
  "mod-host-channel": ModHostChannel,
  "mod-ios": ModIos,
  "mod-keymap": ModKeymap,
  "mod-mobile": ModMobile,
  "mod-picker": ModPicker,
  "mod-storage": ModStorage,
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
