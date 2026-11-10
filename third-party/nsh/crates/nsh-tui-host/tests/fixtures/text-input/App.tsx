import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const value = signal(""), changes = signal(0), selection = signal("0:0");
  const status = signal("idle"), submitted = signal("no");
  return <View>
    <Input testID="name" value={value()} placeholder="Name" style={{ width: 240, height: 16 }}
      onChange={(text) => { value.set(text); changes.set(changes() + 1); }}
      onSelectionChange={(range) => selection.set(`${range.start}:${range.end}`)}
      onFocus={() => status.set("editing")} onBlur={() => status.set("idle")}
      onSubmit={() => submitted.set(value())} />
    <Input testID="password" masked placeholder="Password" style={{ width: 240, height: 16 }} />
    <Input testID="notes" multiline style={{ width: 240, height: 48 }} />
    <Input testID="report" pasteBehavior="report" onPaste={(e) => status.set(`paste:${e.text}`)} style={{ width: 240, height: 16 }} />
    <Text>value:{value().slice(0, 40)}</Text>
    <Text>changes:{changes()} selection:{selection()}</Text>
    <Text>status:{status()} submit:{submitted()}</Text>
  </View>;
}
mount(App);
