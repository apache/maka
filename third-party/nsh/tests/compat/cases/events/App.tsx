// The events domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import EventsComposition from "./events-composition";
import EventsContextMenu from "./events-context-menu";
import EventsGestures from "./events-gestures";
import EventsInput from "./events-input";
import EventsLayout from "./events-layout";
import EventsMedia from "./events-media";
import EventsPinch from "./events-pinch";
import EventsPointer from "./events-pointer";
import EventsScroll from "./events-scroll";
import EventsTouch from "./events-touch";

const cases: Record<string, () => JSX.Element> = {
  "events-composition": EventsComposition,
  "events-context-menu": EventsContextMenu,
  "events-gestures": EventsGestures,
  "events-input": EventsInput,
  "events-layout": EventsLayout,
  "events-media": EventsMedia,
  "events-pinch": EventsPinch,
  "events-pointer": EventsPointer,
  "events-scroll": EventsScroll,
  "events-touch": EventsTouch,
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
