// The base domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import BaseStatusBar from "./base-status-bar";
import BaseAccordion from "./base-accordion";
import BaseAlertDialog from "./base-alert-dialog";
import BaseAvatar from "./base-avatar";
import BaseButton from "./base-button";
import BaseCarousel from "./base-carousel";
import BaseCheckbox from "./base-checkbox";
import BaseCollapsible from "./base-collapsible";
import BaseColorPicker from "./base-color-picker";
import BaseCollapsibleReveal from "./base-collapsible-reveal";
import BaseDialog from "./base-dialog";
import BaseDialogBackdrop from "./base-dialog-backdrop";
import BaseDataTable from "./base-data-table";
import BaseDiff from "./base-diff";
import BaseDock from "./base-dock";
import BaseEditor from "./base-editor";
import BaseHoverCard from "./base-hover-card";
import BaseLink from "./base-link";
import BaseNavPage from "./base-nav-page";
import BaseNavStack from "./base-nav-stack";
import BaseNavStackChange from "./base-nav-stack-change";
import BaseNumberInput from "./base-number-input";
import BaseOtpInput from "./base-otp-input";
import BasePagination from "./base-pagination";
import BasePopups from "./base-popups";
import BaseMenuChecked from "./base-menu-checked";
import BasePlot from "./base-plot";
import BaseProgress from "./base-progress";
import BaseTerminal from "./base-terminal";
import BaseTable from "./base-table";
import BaseRadio from "./base-radio";
import BaseResizable from "./base-resizable";
import BaseRichEditorExtensions from "./base-rich-editor-extensions";
import BaseRichEditorKit from "./base-rich-editor-kit";
import BaseRichEditorSession from "./base-rich-editor-session";
import BaseRichEditorTables from "./base-rich-editor-tables";
import BaseRichEditorView from "./base-rich-editor-view";
import BaseSafeAreaKeyboard from "./base-safe-area-keyboard";
import BaseCombobox from "./base-combobox";
import BaseCommand from "./base-command";
import BaseDatePicker from "./base-date-picker";
import BaseEmojiPicker from "./base-emoji-picker";
import BaseScrollbar from "./base-scrollbar";
import BaseSelect from "./base-select";
import BaseSelectableView from "./base-selectable-view";
import BaseSlider from "./base-slider";
import BaseSwitch from "./base-switch";
import BaseTabs from "./base-tabs";
import BaseTextView from "./base-text-view";
import BaseToast from "./base-toast";
import BaseToggle from "./base-toggle";
import BaseToolbar from "./base-toolbar";
import BaseTree from "./base-tree";
import BaseToken from "./base-token";
import BaseSetTheme from "./base-set-theme";
import BaseTransitionShader from "./base-transition-shader";

const cases: Record<string, () => JSX.Element> = {
  "base-status-bar": BaseStatusBar,
  "base-accordion": BaseAccordion,
  "base-alert-dialog": BaseAlertDialog,
  "base-avatar": BaseAvatar,
  "base-button": BaseButton,
  "base-carousel": BaseCarousel,
  "base-dialog": BaseDialog,
  "base-dialog-backdrop": BaseDialogBackdrop,
  "base-data-table": BaseDataTable,
  "base-diff": BaseDiff,
  "base-dock": BaseDock,
  "base-editor": BaseEditor,
  "base-hover-card": BaseHoverCard,
  "base-link": BaseLink,
  "base-nav-page": BaseNavPage,
  "base-nav-stack": BaseNavStack,
  "base-nav-stack-change": BaseNavStackChange,
  "base-number-input": BaseNumberInput,
  "base-otp-input": BaseOtpInput,
  "base-pagination": BasePagination,
  "base-popups": BasePopups,
  "base-menu-checked": BaseMenuChecked,
  "base-safe-area-keyboard": BaseSafeAreaKeyboard,
  "base-text-view": BaseTextView,
  "base-selectable-view": BaseSelectableView,
  "base-switch": BaseSwitch,
  "base-checkbox": BaseCheckbox,
  "base-radio": BaseRadio,
  "base-resizable": BaseResizable,
  "base-rich-editor-extensions": BaseRichEditorExtensions,
  "base-rich-editor-kit": BaseRichEditorKit,
  "base-rich-editor-session": BaseRichEditorSession,
  "base-rich-editor-view": BaseRichEditorView,
  "base-rich-editor-tables": BaseRichEditorTables,
  "base-tabs": BaseTabs,
  "base-toggle": BaseToggle,
  "base-toolbar": BaseToolbar,
  "base-tree": BaseTree,
  "base-collapsible": BaseCollapsible,
  "base-color-picker": BaseColorPicker,
  "base-collapsible-reveal": BaseCollapsibleReveal,
  "base-plot": BasePlot,
  "base-progress": BaseProgress,
  "base-terminal": BaseTerminal,
  "base-combobox": BaseCombobox,
  "base-command": BaseCommand,
  "base-date-picker": BaseDatePicker,
  "base-emoji-picker": BaseEmojiPicker,
  "base-scrollbar": BaseScrollbar,
  "base-select": BaseSelect,
  "base-slider": BaseSlider,
  "base-table": BaseTable,
  "base-toast": BaseToast,
  "base-token": BaseToken,
  "base-set-theme": BaseSetTheme,
  "base-transition-shader": BaseTransitionShader,
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
