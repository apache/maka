// The browser domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import BasePopupsDesktop from "./base-popups-desktop";
import PropsPlatformWeb from "./props-platform-web";
import PropsTextScaling from "./props-text-scaling";
import PropsMediaWebviewDesktop from "./props-media-webview-desktop";

import RuntimeIdentities from "./runtime-identities";

const cases: Record<string, () => JSX.Element> = {
  "runtime-identities": RuntimeIdentities,
  "props-platform-web": PropsPlatformWeb,
  "props-text-scaling": PropsTextScaling,
  "props-media-webview-desktop": PropsMediaWebviewDesktop,
  "base-popups-desktop": BasePopupsDesktop,
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
