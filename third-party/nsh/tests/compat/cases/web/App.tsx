// The web domain of the API's test apps (docs/dev/compatibility.md):
// each case is a module of its own, shown alone when the script taps
// `id:case-<case>` (a one-point view over the corner, out of the layout);
// the steps after it are that case's.
import { type JSX, View, mount, signal } from "nsh";
import WebBlob from "./web-blob";
import WebControlFlow from "./web-control-flow";
import WebEncoding from "./web-encoding";
import WebEvents from "./web-events";
import WebFetch from "./web-fetch";
import WebStreams from "./web-streams";
import WebTimers from "./web-timers";
import WebUrl from "./web-url";

const cases: Record<string, () => JSX.Element> = {
  "web-blob": WebBlob,
  "web-control-flow": WebControlFlow,
  "web-encoding": WebEncoding,
  "web-events": WebEvents,
  "web-fetch": WebFetch,
  "web-streams": WebStreams,
  "web-timers": WebTimers,
  "web-url": WebUrl,
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
