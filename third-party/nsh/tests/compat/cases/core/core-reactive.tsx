// A case of the API's test suite (docs/dev/compatibility.md): the reactive
// primitives of `nsh` (computed, effect, batch, untracked, cleanup, split)
// and what the JSX compiler emits for them (`<If>`: `cond`; spread props
// on a host element: `spread`; on a component: `merge`), each rendered as
// text or layout. Its script checks
// each.
import { Text, View, batch, cleanup, computed, effect, signal, split, untracked } from "nsh";
import type { ViewProps } from "nsh";

const cleanups = signal(0);

function Child() {
  cleanup(() => cleanups.set(untracked(cleanups) + 1));
  return <Text>Child shown</Text>;
}

function Labeled(props: ViewProps & { label: string }) {
  const [own, rest] = split(props, ["label"]);
  return (
    <View {...rest}>
      <Text>{own.label}</Text>
    </View>
  );
}

function App() {
  const a = signal(1);
  const b = signal(2);
  const sum = computed(() => a() + b());
  // Follows `a` only: `b` is read untracked.
  const peek = computed(() => a() + untracked(() => b()));
  const runs = signal(0);
  effect(() => {
    sum();
    untracked(() => runs.set(runs() + 1));
  });
  const shown = signal(true);
  const extra = { testID: "merged", style: { width: 140, height: 30 } };
  return (
    <View testID="root" style={{ flex: 1, paddingTop: 64 }}>
      <Text>Sum: {sum()}</Text>
      <Text>Peek: {peek()}</Text>
      <Text>Effect runs: {runs()}</Text>
      <Text>Batched: {batch(() => "yes")}</Text>
      <View testID="only-b" onPress={() => b.set(b() + 1)}>
        <Text>Set b</Text>
      </View>
      <View
        testID="both"
        onPress={() =>
          batch(() => {
            a.set(10);
            b.set(20);
          })
        }
      >
        <Text>Set both</Text>
      </View>
      <If when={shown()} else={<Text>Child hidden</Text>}>
        <Child />
      </If>
      <Text>Cleanups: {cleanups()}</Text>
      <View testID="toggle" onPress={() => shown.set(!shown())}>
        <Text>Toggle</Text>
      </View>
      <Labeled testID="split" label="Split label" style={{ width: 120, height: 24 }} />
      <Labeled {...extra} label="Merged label" />
    </View>
  );
}

export default App;
