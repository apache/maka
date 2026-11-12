import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

// A field closed while it has the focus: kept alive by the cycle through
// its ref, it must take no more keys, or its component, gone, submits.
function Field(props: { submitted: { set(value: string): void } }) {
  let input: unknown;
  return (
    <Input
      ref={(node) => (input = node)}
      testID="field"
      onSubmit={() => input && props.submitted.set("yes")}
      style={{ height: 40 }}
    />
  );
}

function App() {
  const shown = signal(true);
  const submitted = signal("no");
  return (
    <View style={{ flex: 1 }}>
      <View onPress={() => shown.set(false)} style={{ height: 40 }}>
        <Text>Close</Text>
      </View>
      <If when={shown()}>
        <Field submitted={submitted} />
      </If>
      <Text>{`Submitted: ${submitted()}`}</Text>
    </View>
  );
}

mount(App);
