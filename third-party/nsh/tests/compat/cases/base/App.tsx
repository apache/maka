// The base domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import BaseStatusBar from "./base-status-bar";
import BaseAlertDialog from "./base-alert-dialog";
import BaseButton from "./base-button";
import BaseCheckbox from "./base-checkbox";
import BaseCollapsible from "./base-collapsible";
import BaseDialog from "./base-dialog";
import BaseDialogBackdrop from "./base-dialog-backdrop";
import BaseDock from "./base-dock";
import BaseNavPage from "./base-nav-page";
import BaseNavStack from "./base-nav-stack";
import BasePopups from "./base-popups";
import BaseProgress from "./base-progress";
import BaseRadio from "./base-radio";
import BaseResizable from "./base-resizable";
import BaseSafeAreaKeyboard from "./base-safe-area-keyboard";
import BaseSelectionArea from "./base-selection-area";
import BaseSwitch from "./base-switch";
import BaseTabs from "./base-tabs";
import BaseTextView from "./base-text-view";
import BaseToast from "./base-toast";
import BaseToken from "./base-token";

const cases: Record<string, () => JSX.Element> = {
  "base-status-bar": BaseStatusBar,
  "base-alert-dialog": BaseAlertDialog,
  "base-button": BaseButton,
  "base-dialog": BaseDialog,
  "base-dialog-backdrop": BaseDialogBackdrop,
  "base-dock": BaseDock,
  "base-nav-page": BaseNavPage,
  "base-nav-stack": BaseNavStack,
  "base-popups": BasePopups,
  "base-safe-area-keyboard": BaseSafeAreaKeyboard,
  "base-text-view": BaseTextView,
  "base-selection-area": BaseSelectionArea,
  "base-switch": BaseSwitch,
  "base-checkbox": BaseCheckbox,
  "base-radio": BaseRadio,
  "base-resizable": BaseResizable,
  "base-tabs": BaseTabs,
  "base-collapsible": BaseCollapsible,
  "base-progress": BaseProgress,
  "base-toast": BaseToast,
  "base-token": BaseToken,
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
