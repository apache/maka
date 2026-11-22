// Links, controls and inputs kept mounted in hidden views, one `display: none`
// from the start and one hidden after it showed, before a control that
// shows and tabs that X hides. `hidden-focus.test.tsx` runs it.
import { keymap, mount, platform, signal, Text, View } from "nsh";
import { Input, Link, Tab, Tabs } from "nsh/base";

function App() {
  const log = signal<string[]>([]);
  const note = (event: string) => log.set([...log(), event]);
  const choice = signal("One");
  const shown = signal(true);
  const away = signal(false);
  keymap.bind("x", () => away.set(true));
  // Laid out once, then hidden: its views had frames before.
  setTimeout(() => shown.set(false), 100);
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
  // A link is an `<a href>` on the web, a Tab stop without a `tabindex`.
  const link = (name: string) => (
    <Link href={`/${name.toLowerCase()}`} openWith="app" style={box}>
      <Text>{`${name} link`}</Text>
    </Link>
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
        {link("Gone")}
        {control("Gone")}
        {field("Gone field")}
      </View>
      <View style={{ display: shown() ? "flex" : "none", gap: 8 }}>
        {link("Left")}
        {control("Left")}
        {field("Left field")}
      </View>
      {control("Shown")}
      <View style={{ display: away() ? "none" : "flex" }}>
        <Tabs style={{ flexDirection: "row", gap: 8 }}>
          {tab("One")}
          {tab("Two")}
        </Tabs>
      </View>
      <Text>{`Log: ${log().join(", ")}`}</Text>
      <Text>{shown() ? "Panel shown" : "Panel hidden"}</Text>
      <Text>{away() ? "Tabs hidden" : "Tabs shown"}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
    </View>
  );
}

mount(App);
