// A case of the API's test suite (docs/dev/compatibility.md): `Command` of
// `nsh/base`, a command palette with no look of its own: the items as data
// (sections, keywords, a shortcut, a disabled and a checked item), the
// roles and states screen readers get (a list box of options), the first
// enabled item highlighted (`focus:`, `onHighlightChange`), the app's query
// (`query`, `onQueryChange`) filtering by label, a press choosing
// (`onSelect`), the slots (`header`, `footer`, `empty`, `searchPrefix`),
// every part in the app's look, `renderItem` and `renderGroup`; the field's
// own query from `defaultQuery`, the search field's own name for screen
// readers (`searchAccessibilityLabel`), a search the app answers
// (`filterable={false}`, `loading`), and a command without a search field
// (`searchable={false}`).
import { Text, View, signal } from "nsh";
import { Command, type CommandItem } from "nsh/base";

const ITEMS: CommandItem[] = [
  { id: "new", label: "New File", shortcut: "mod+n" },
  { id: "calendar", label: "Calendar", group: "Suggestions" },
  { id: "emoji", label: "Search Emoji", group: "Suggestions", disabled: true },
  { id: "profile", label: "Profile", group: "Settings", keywords: ["account"] },
  { id: "dark", label: "Dark Theme", group: "Settings", checked: true },
];

const REMOTE: CommandItem[] = [
  { id: "r1", label: "Remote One" },
  { id: "r2", label: "Remote Two" },
];

const SERVER: CommandItem[] = [
  { id: "s1", label: "Server A", group: "Answers" },
  { id: "s2", label: "Server B", group: "More" },
];

function App() {
  const chosen = signal("none");
  const lit = signal("none");
  const query = signal("");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Chosen: ${chosen()}`}</Text>
      <Text>{`Lit: ${lit()}`}</Text>
      <Text>{`Query: ${query()}`}</Text>
      <Command
        items={ITEMS}
        query={query()}
        onQueryChange={({ query: next }) => query.set(next)}
        onSelect={({ id }) => chosen.set(id)}
        onHighlightChange={({ highlighted }) => lit.set(highlighted ?? "none")}
        placeholder="FindCommand"
        accessibilityLabel="Commands"
        style={{ height: 320 }}
        searchBarClass="flex-row h-[44px]"
        searchClass="flex-1"
        listClass="bg-[#0000ff]"
        itemClass="h-[30px] focus:h-[40px] disabled:h-[24px] checked:bg-[#00ff00]"
        groupClass="h-[20px]"
        header={<Text>PaletteHeader</Text>}
        footer={<Text>PaletteFooter</Text>}
        empty={<Text>NoCommands</Text>}
        searchPrefix={<Text>Find:</Text>}
        renderItem={(entry) => <Text>{`${entry.label}${entry.shortcutLabel ? " +key" : ""}`}</Text>}
        renderGroup={(group) => <Text>{`[${group.heading}]`}</Text>}
      />
      <Command
        items={REMOTE}
        defaultQuery="Two"
        placeholder="FindRemote"
        searchAccessibilityLabel="SearchRemote"
        style={{ height: 80 }}
      />
      <Command
        items={SERVER}
        defaultQuery="zz"
        filterable={false}
        loading
        separator={false}
        placeholder="FindServer"
        empty={<Text>ServerEmpty</Text>}
        accessibilityLabel="Server"
        style={{ height: 100 }}
      />
      <Command
        items={[{ id: "g", label: "Gamma" }]}
        searchable={false}
        placeholder="NoField"
        style={{ height: 60 }}
      />
    </View>
  );
}

export default App;
