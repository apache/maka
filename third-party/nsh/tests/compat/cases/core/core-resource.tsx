// A case of the API's test suite (docs/dev/compatibility.md): `resource`,
// a value loaded asynchronously. A resource following a source shows its
// state, value, error and whether it loads as text; its loads end when the
// script taps Resolve or Reject, so each state is checked as long as it
// lasts: the first load, a new source (superseding the load before it,
// which is aborted), a failure, `mutate`, `refetch` (which the fetcher is
// told) and an unset source (which loads nothing). Resources without a
// source show a value given at once, an `initialValue` and a fetcher that
// throws; one in a component going away aborts its load. Its script checks
// each.
import { Text, View, resource, signal } from "nsh";

const childAborts = signal(0);

function Child() {
  const r = resource(
    (info) =>
      new Promise<string>(() => {
        info.signal.addEventListener("abort", () => childAborts.set(childAborts() + 1));
      }),
  );
  return <Text>Child: {r.state()}</Text>;
}

function App() {
  const id = signal<number | null>(1);
  const loads = signal(0);
  const aborts = signal(0);
  let running: { resolve: () => void; reject: () => void } | undefined;
  const user = resource(id, (n, info) => {
    loads.set(loads() + 1);
    return new Promise<string>((resolve, reject) => {
      running = {
        resolve: () => resolve(`user ${n}${info.refetching ? " again" : ""}`),
        reject: () => reject(new Error(`no user ${n}`)),
      };
      info.signal.addEventListener("abort", () => aborts.set(aborts() + 1));
    });
  });
  const now = resource(() => 42);
  const kept = resource(() => new Promise<string>(() => {}), { initialValue: "first" });
  const thrown = resource((): string => {
    throw new Error("thrown");
  });
  const shown = signal(true);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>State: {user.state()}</Text>
      <Text>Value: {user() ?? "none"}</Text>
      <Text>Error: {String(user.error() ?? "none")}</Text>
      <Text>Loading: {user.loading() ? "yes" : "no"}</Text>
      <Text>Loads: {loads()}</Text>
      <Text>Aborts: {aborts()}</Text>
      <Text>Now: {now.state()} {now()}</Text>
      <Text>Kept: {kept.state()} {kept()} {kept.loading() ? "loading" : "idle"}</Text>
      <Text>Thrown: {thrown.state()} {String(thrown.error())}</Text>
      <If when={shown()} else={<Text>Child gone</Text>}>
        <Child />
      </If>
      <Text>Child aborts: {childAborts()}</Text>
      <View testID="resolve" onPress={() => running?.resolve()}>
        <Text>Resolve</Text>
      </View>
      <View testID="reject" onPress={() => running?.reject()}>
        <Text>Reject</Text>
      </View>
      <View testID="next" onPress={() => id.set((id() ?? 0) + 1)}>
        <Text>Next</Text>
      </View>
      <View testID="refetch" onPress={() => user.refetch()}>
        <Text>Refetch</Text>
      </View>
      <View testID="mutate" onPress={() => user.mutate("local")}>
        <Text>Mutate</Text>
      </View>
      <View testID="clear" onPress={() => id.set(null)}>
        <Text>Clear</Text>
      </View>
      <View testID="hide" onPress={() => shown.set(false)}>
        <Text>Hide</Text>
      </View>
    </View>
  );
}

export default App;
