// The layout domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import CoreRegisterFont from "./core-register-font";
import CoreTheme from "./core-theme";
import LayoutBox from "./layout-box";
import LayoutDirection from "./layout-direction";
import LayoutFlex from "./layout-flex";
import LayoutGrid from "./layout-grid";
import LayoutTailwind from "./layout-tailwind";
import LayoutSticky from "./layout-sticky";

const cases: Record<string, () => JSX.Element> = {
  "core-register-font": CoreRegisterFont,
  "core-theme": CoreTheme,
  "layout-box": LayoutBox,
  "layout-direction": LayoutDirection,
  "layout-flex": LayoutFlex,
  "layout-grid": LayoutGrid,
  "layout-tailwind": LayoutTailwind,
  "layout-sticky": LayoutSticky,
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
