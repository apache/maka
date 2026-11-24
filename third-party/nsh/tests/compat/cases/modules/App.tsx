// The modules domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import { Window } from "nsh/desktop";
import ModStandardAccess from "./mod-standard-access";
import ModAccessibility from "./mod-accessibility";
import ModAndroid from "./mod-android";
import ModAppInfo from "./mod-app-info";
import ModAppSettings from "./mod-app-settings";
import ModAudio from "./mod-audio";
import ModClipboard from "./mod-clipboard";
import ModFps from "./mod-fps";
import ModFpsMode from "./mod-fps-mode";
import ModPerfStats from "./mod-perf-stats";
import ModUrlScheme from "./mod-url-scheme";
import ModDesktop from "./mod-desktop";
import ModDevice from "./mod-device";
import ModHaptics from "./mod-haptics";
import ModHost from "./mod-host";
import ModHostChannel from "./mod-host-channel";
import ModI18n from "./mod-i18n";
import ModIos from "./mod-ios";
import ModKeymap from "./mod-keymap";
import ModMobile from "./mod-mobile";
import ModPicker from "./mod-picker";
import ModShare from "./mod-share";
import ModNotifications from "./mod-notifications";
import ModSpeech from "./mod-speech";
import ModStorage from "./mod-storage";
import ModWeb from "./mod-web";
import ModUpdater from "./mod-updater";

const cases: Record<string, () => JSX.Element> = {
  "mod-standard-access": ModStandardAccess,
  "mod-accessibility": ModAccessibility,
  "mod-android": ModAndroid,
  "mod-app-info": ModAppInfo,
  "mod-app-settings": ModAppSettings,
  "mod-audio": ModAudio,
  "mod-clipboard": ModClipboard,
  "mod-fps": ModFps,
  "mod-fps-mode": ModFpsMode,
  "mod-perf-stats": ModPerfStats,
  "mod-url-scheme": ModUrlScheme,
  "mod-desktop": ModDesktop,
  "mod-device": ModDevice,
  "mod-host": ModHost,
  "mod-host-channel": ModHostChannel,
  "mod-haptics": ModHaptics,
  "mod-i18n": ModI18n,
  "mod-ios": ModIos,
  "mod-keymap": ModKeymap,
  "mod-mobile": ModMobile,
  "mod-picker": ModPicker,
  "mod-share": ModShare,
  "mod-notifications": ModNotifications,
  "mod-speech": ModSpeech,
  "mod-storage": ModStorage,
  "mod-web": ModWeb,
  "mod-updater": ModUpdater,
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
