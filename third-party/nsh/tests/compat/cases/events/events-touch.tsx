// A case of the API's test suite (docs/dev/compatibility.md): the touch
// handlers, capturing and bubbling, and the responder system: a view that
// takes the touches and keeps them to the end, one that refuses to let go
// (its parent is rejected), and one that lets its parent take over before
// the system cancels the touch. Each logs what it gets as text. Its script checks
// each.
import { type Signal, Text, View, signal } from "nsh";

type Log = Signal<string[]>;

function note(log: Log, line: string) {
  log.update((l) => [...l, line]);
}

function App() {
  const a: Log = signal<string[]>([]);
  const b: Log = signal<string[]>([]);
  const c: Log = signal<string[]>([]);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <View
        testID="outer"
        style={{ padding: 10 }}
        onTouchStartCapture={() => note(a, "capstart")}
        onTouchMoveCapture={() => note(a, "capmove")}
        onTouchEndCapture={() => note(a, "capend")}
        onStartShouldSetResponderCapture={(_, g) => {
          note(a, `askcap ${g.numberActiveTouches}`);
          return false;
        }}
        onMoveShouldSetResponderCapture={(_, g) => {
          note(a, `askmovecap ${g.dx},${g.dy}`);
          return false;
        }}
      >
        <View
          testID="pad"
          style={{ height: 60 }}
          onTouchStart={(e) =>
            note(
              a,
              `start ${e.locationX},${e.locationY} page ${e.pageX},${e.pageY} ` +
                `${e.touches.length}/${e.changedTouches.length} #${e.identifier} ` +
                `at ${e.timestamp} ${typeof e.target}`,
            )
          }
          onTouchMove={(e) => note(a, `move ${e.locationX},${e.locationY} page ${e.pageX},${e.pageY}`)}
          onTouchEnd={(e) => note(a, `end ${e.touches.length}/${e.changedTouches.length}`)}
          onStartShouldSetResponder={(_, g) => {
            note(a, `ask ${g.x0},${g.y0}`);
            return true;
          }}
          onResponderGrant={() => {
            note(a, "grant");
            return true;
          }}
          onResponderStart={(e) => note(a, `rstart ${e.locationX}`)}
          onResponderMove={(e) => note(a, `rmove ${e.locationX}`)}
          onResponderEnd={(e) => note(a, `rend ${e.locationX}`)}
          onResponderRelease={() => note(a, "release")}
        />
      </View>
      <Text>{"A: " + a().join(" | ")}</Text>
      <View
        testID="b-parent"
        onMoveShouldSetResponderCapture={(_, g) => {
          note(b, `want ${g.dx},${g.dy}`);
          return true;
        }}
        onResponderGrant={() => note(b, "parent grant")}
        onResponderReject={() => note(b, "reject")}
      >
        <View
          testID="keeper"
          style={{ height: 40 }}
          onStartShouldSetResponder={() => true}
          onResponderGrant={() => note(b, "keeper grant")}
          onResponderTerminationRequest={() => {
            note(b, "request");
            return false;
          }}
          onResponderTerminate={() => note(b, "keeper terminate")}
          onResponderRelease={() => note(b, "keeper release")}
        />
      </View>
      <Text>{"B: " + b().join(" | ")}</Text>
      <View
        testID="c-parent"
        onMoveShouldSetResponder={(_, g) => {
          note(c, `want ${g.dx},${g.dy} at ${g.moveX},${g.moveY} of ${g.numberActiveTouches}`);
          return true;
        }}
        onResponderGrant={() => note(c, "parent grant")}
        onResponderTerminate={() => note(c, "parent terminate")}
        onTouchCancelCapture={() => note(c, "capcancel")}
        onTouchCancel={() => note(c, "cancel")}
      >
        <View
          testID="yielder"
          style={{ height: 40 }}
          onStartShouldSetResponder={() => true}
          onResponderGrant={() => note(c, "yielder grant")}
          onResponderTerminationRequest={() => {
            note(c, "request");
            return true;
          }}
          onResponderTerminate={() => note(c, "yielder terminate")}
        />
      </View>
      <Text>{"C: " + c().join(" | ")}</Text>
    </View>
  );
}

export default App;
