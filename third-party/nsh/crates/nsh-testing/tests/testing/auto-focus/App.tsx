import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { Input } from "nsh/base";

// A field that asks for the focus when it mounts (`autoFocus`), one that
// does not, and a second asking field mounted later, as a palette opened
// over a page: each reports the focus it takes and loses.
function App() {
  const focus = signal("none");
  const open = signal(false);
  const submitted = signal("none");
  const field = (name: string, autoFocus: boolean) => (
    <Input
      testID={name}
      autoFocus={autoFocus}
      onFocus={() => focus.set(name)}
      onBlur={() => focus() === name && focus.set("none")}
      onSubmit={() => submitted.set(name)}
      style={{ height: 40 }}
    />
  );
  return (
    <View style={{ flex: 1 }}>
      {field("plain", false)}
      {field("search", true)}
      <View onPress={() => open.set(true)} style={{ height: 40 }}>
        <Text>Open</Text>
      </View>
      <If when={open()}>{field("palette", true)}</If>
      <Text>{`Focus: ${focus()}`}</Text>
      <Text>{`Submitted: ${submitted()}`}</Text>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
