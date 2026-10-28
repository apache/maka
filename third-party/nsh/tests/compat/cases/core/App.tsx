// The core domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import Context from "./context";
import CoreAnimated from "./core-animated";
import CoreCanvas from "./core-canvas";
import CoreElements from "./core-elements";
import CoreInputAction from "./core-input-action";
import CoreErrorBoundary from "./core-error-boundary";
import CoreList from "./core-list";
import CoreListBinding from "./core-list-binding";
import CoreMotion from "./core-motion";
import CoreOverlay from "./core-overlay";
import CorePrimitives from "./core-primitives";
import CoreReactive from "./core-reactive";
import CoreRef from "./core-ref";
import CoreResource from "./core-resource";
import CoreShader from "./core-shader";
import ModuleUrl from "./module-url";
import Steps from "./steps";

const cases: Record<string, () => JSX.Element> = {
  "context": Context,
  "core-animated": CoreAnimated,
  "core-canvas": CoreCanvas,
  "core-elements": CoreElements,
  "core-input-action": CoreInputAction,
  "core-error-boundary": CoreErrorBoundary,
  "core-list": CoreList,
  "core-list-binding": CoreListBinding,
  "core-motion": CoreMotion,
  "core-overlay": CoreOverlay,
  "core-primitives": CorePrimitives,
  "core-reactive": CoreReactive,
  "core-ref": CoreRef,
  "core-resource": CoreResource,
  "core-shader": CoreShader,
  "module-url": ModuleUrl,
  "steps": Steps,
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
