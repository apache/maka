import { mount, platform, signal, Text, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { Button } from "../../../nsh-gallery-ui";

// #2226: identical long fields expose a shared field editor's stale scroll.
// Keep the first copy idle as a visual reference; focus the others by button
// (programmatically), Tab or click. No application-side geometry correction.
function App() {
  const long = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789";
  const caret = signal("none");
  let target: InputRef | undefined;
  let short: InputRef | undefined;
  const field = "text-foreground border border-border rounded-md px-3 h-10";
  return (
    <View class="flex-1 bg-background p-6 gap-3">
      <Text class="text-foreground text-lg">Single-line focus alignment</Text>
      <Text class="text-muted-foreground">The two long fields should start at the same horizontal position.</Text>
      <View class="gap-3" style={{ width: 280 }}>
        <Input testID="reference" accessibilityLabel="Unfocused reference" class={field} defaultValue={long} />
        <Input testID="long" accessibilityLabel="Long text" ref={(r) => (target = r)} class={field}
          defaultValue={long}
          onCaretMove={(e) => caret.set(`${e.bounds.origin.x} ${e.bounds.size.width}`)} />
        <Input testID="short" accessibilityLabel="Short text" ref={(r) => (short = r)} class={field} defaultValue="ABC" />
        <Input testID="center" accessibilityLabel="Centered text" class={`${field} text-center`} defaultValue="Centered" />
        <Input testID="right" accessibilityLabel="Right aligned text" class={`${field} text-right`} defaultValue="Right aligned" />
      </View>
      <View class="flex-row gap-4">
        <Button label="Focus long" onPress={() => target?.focus()} />
        <Button label="Focus short" onPress={() => short?.focus()} />
      </View>
      <Text class="text-muted-foreground">{`Caret ${caret()}`}</Text>
      <Text class="text-muted-foreground">{`Platform ${platform.name}`}</Text>
    </View>
  );
}
mount(App);
