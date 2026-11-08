// Two screens and an application menu: Command+[ goes back from the second
// one (`navigation::key_pressed`) with a menu around that does not take it.
// `Nav.test.tsx` runs it on the macOS host.
import { mount, signal, Text, View, WebView } from "nsh";
import { Button, createNavStack, NavPage, NavStack } from "nsh/base";
import { Menu } from "nsh/desktop";

type Route = "root" | "detail";

function App() {
  const nav = createNavStack<Route>(["root"]);
  const real = signal("asking");
  WebView.inputAvailable().then((available) => real.set(`${available}`));
  Menu.setApplicationMenu([
    { label: "Fixture", submenu: [{ role: "quit" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "selectAll" }] },
  ]);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage title={route} headerVisible={false}>
          <View style={{ flex: 1, padding: 16, gap: 12 }}>
            <Text>{`Page: ${route}`}</Text>
            <Text>{`Real host: ${real()}`}</Text>
            {route === "root" ? (
              <Button onPress={() => nav.push("detail")} accessibilityLabel="Open detail" style={{ minHeight: 44 }}>
                <Text>Open detail</Text>
              </Button>
            ) : null}
          </View>
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
