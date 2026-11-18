// A case of the API's test suite (docs/dev/compatibility.md): trailing
// iOS bar buttons (`ios.headerRightItems`) with `nsh/desktop`'s `MenuItem`
// menus (`destructive`, `inline`, `symbol`) and per-item `onPress` /
// `onSelect`. Other platforms ignore the iOS items and keep `headerRight`.
import { Text, View, signal } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack<string>(["home"]);
const log = signal("none");
const filter = signal("all");

function Home() {
  return (
    <NavPage
      {...{ testID: "home" }}
      title="Header items"
      headerRight={<Text>Fallback right</Text>}
      ios={{
        headerRightItems: [
          {
            key: "edit",
            systemItem: "edit",
            label: "Edit",
            onPress: () => log.set("press edit"),
          },
          {
            key: "filter",
            label: "Filter",
            menu: [
              {
                label: "All",
                checked: filter() === "all",
                onSelect: () => {
                  filter.set("all");
                  log.set("menu all");
                },
              },
              {
                label: "Open",
                checked: filter() === "open",
                onSelect: () => {
                  filter.set("open");
                  log.set("menu open");
                },
              },
              {
                label: "Danger",
                inline: true,
                submenu: [
                  {
                    label: "Delete",
                    destructive: true,
                    symbol: "trash",
                    onSelect: () => log.set("menu delete"),
                  },
                ],
              },
            ],
          },
          { key: "add", systemItem: "add", onPress: () => log.set("press add") },
        ],
      }}
    >
      <Text>{`Log: ${log()}`}</Text>
      <Text>{`Filter: ${filter()}`}</Text>
    </NavPage>
  );
}

function App() {
  return (
    <View style={{ flex: 1 }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {() => <Home />}
      </NavStack>
    </View>
  );
}

export default App;
