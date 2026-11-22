// A case of the API's test suite (docs/dev/compatibility.md): an
// `ErrorBoundary` shows its fallback in place of what threw (a binding, a
// listener), keeps what is around it, and `reset` renders the children
// again; a fallback that throws goes to the boundary above, and a function
// fallback gets the error whatever parameters it declares. Its script
// checks each.
import { ErrorBoundary, Text, View, signal } from "nsh";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Risky(props: { broken: () => boolean }) {
  return (
    <View testID="risky" onPress={() => { throw new Error("pressed"); }}>
      <Text>{props.broken() ? (() => { throw new Error("binding"); })() : "Risky ok"}</Text>
    </View>
  );
}

function App() {
  const broken = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Around the boundary</Text>
      <ErrorBoundary
        fallback={(error, reset) => (
          <View testID="retry" onPress={() => { broken.set(false); reset(); }}>
            <Text>Caught {message(error)}</Text>
          </View>
        )}
      >
        <Risky broken={broken} />
      </ErrorBoundary>
      <View testID="break" onPress={() => broken.set(true)}>
        <Text>Break</Text>
      </View>
      <ErrorBoundary fallback={(error) => <Text>Outer caught {message(error)}</Text>}>
        <ErrorBoundary fallback={(error) => { throw new Error(`fallback of ${message(error)}`); }}>
          <Risky broken={() => true} />
        </ErrorBoundary>
      </ErrorBoundary>
      <ErrorBoundary fallback={(...args: unknown[]) => <Text>Rest caught {message(args[0])}</Text>}>
        <Risky broken={() => true} />
      </ErrorBoundary>
    </View>
  );
}

export default App;
