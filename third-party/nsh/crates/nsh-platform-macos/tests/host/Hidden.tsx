// Controls and inputs kept mounted in hidden views, a `display: none` one
// and a `visibility: hidden` one, before a control that shows and tabs
// that X hides. `Hidden.test.tsx` runs it on the macOS host.
import { keymap, mount, signal, Text, View } from "nsh";
import { Input, Tab, Tabs } from "nsh/base";

function App() {
  const log = signal<string[]>([]);
  const note = (event: string) => log.set([...log(), event]);
  const choice = signal("One");
  const away = signal(false);
  keymap.bind("x", () => away.set(true));
  const box = { width: 120, height: 32, justifyContent: "center", backgroundColor: "#e5e5e5" } as const;
  const control = (name: string) => (
    <View onFocus={() => note(`${name} focused`)} onPress={() => note(`${name} pressed`)} style={box}>
      <Text>{name}</Text>
    </View>
  );
  const field = (name: string) => (
    <Input
      placeholder={name}
      onFocus={() => note(`${name} focused`)}
      style={{ width: 120, height: 32, borderWidth: 1, borderColor: "#d4d4d4" }}
    />
  );
  const tab = (name: string) => (
    <Tab
      selected={choice() === name}
      onPress={() => {
        choice.set(name);
        note(`${name} pressed`);
      }}
      style={box}
    >
      <Text>{name}</Text>
    </Tab>
  );
  return (
    <View style={{ flex: 1, padding: 16, gap: 8, backgroundColor: "white" }}>
      <View style={{ display: "none", gap: 8 }}>
        {control("Gone")}
        {field("Gone field")}
      </View>
      <View style={{ visibility: "hidden", gap: 8 }}>
        {control("Unseen")}
        {field("Unseen field")}
      </View>
      {control("Shown")}
      <View style={{ display: away() ? "none" : "flex" }}>
        <Tabs style={{ flexDirection: "row", gap: 8 }}>
          {tab("One")}
          {tab("Two")}
        </Tabs>
      </View>
      <Text>{`Log: ${log().join(", ")}`}</Text>
      <Text>{away() ? "Tabs hidden" : "Tabs shown"}</Text>
    </View>
  );
}

mount(App);
