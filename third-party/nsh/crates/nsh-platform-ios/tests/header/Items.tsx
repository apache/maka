import { mount, signal, Text, View } from "nsh";
import { Button, createNavStack, Menu, MenuItem, NavPage, NavStack } from "nsh/base";

type Route = "root" | "pushed";

/** A page whose header's trailing slot holds a button, a pressable view and
 * a menu's trigger: the bar wraps them as one custom bar button item. */
function App() {
  const nav = createNavStack<Route>(["root"]);
  const buttons = signal(0);
  const views = signal(0);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage
          title={route}
          headerRight={
            route === "root" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Button testID="header-button" accessibilityLabel="Header button" onPress={() => buttons.set(buttons() + 1)} style={{ padding: 6 }}>
                  <Text>Add</Text>
                </Button>
                <View testID="header-view" role="button" accessibilityLabel="Header view" onPress={() => views.set(views() + 1)} style={{ padding: 6 }}>
                  <Text>Tap</Text>
                </View>
                <Menu
                  trigger={
                    <Button testID="header-menu" accessibilityLabel="Header menu" style={{ padding: 6 }}>
                      <Text>More</Text>
                    </Button>
                  }
                >
                  <MenuItem onSelect={() => nav.push("pushed")}>
                    <Text>Open page</Text>
                  </MenuItem>
                </Menu>
              </View>
            ) : undefined
          }
        >
          <View style={{ flex: 1, padding: 16, gap: 12 }}>
            <Text>{`Page: ${route}`}</Text>
            <Text>{`Header button: ${buttons()}`}</Text>
            <Text>{`Header view: ${views()}`}</Text>
          </View>
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
