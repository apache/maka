// The paint domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import PaintBorders from "./paint-borders";
import PaintCurrentColor from "./paint-current-color";
import PaintEffects from "./paint-effects";
import PaintInlineAlign from "./paint-inline-align";
import PaintMisc from "./paint-misc";
import PaintMotion from "./paint-motion";
import PaintObjectPosition from "./paint-object-position";
import PaintShadows from "./paint-shadows";
import PaintTailwind from "./paint-tailwind";
import PaintText from "./paint-text";
import StateStyles from "./state-styles";
import StateChecked from "./state-checked";
import StateIndeterminate from "./state-indeterminate";

const cases: Record<string, () => JSX.Element> = {
  "paint-borders": PaintBorders,
  "paint-current-color": PaintCurrentColor,
  "paint-effects": PaintEffects,
  "paint-misc": PaintMisc,
  "paint-motion": PaintMotion,
  "paint-object-position": PaintObjectPosition,
  "paint-shadows": PaintShadows,
  "paint-text": PaintText,
  "paint-tailwind": PaintTailwind,
  "state-styles": StateStyles,
  "state-checked": StateChecked,
  "state-indeterminate": StateIndeterminate,
  "paint-inline-align": PaintInlineAlign,
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
