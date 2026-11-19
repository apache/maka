import { mount, signal, Text, View } from "nsh";
import { ContextMenu, createNavStack, Dialog, MenuButton, NavPage, NavStack } from "nsh/base";

/** What UIKit draws for the app outside its views: header bar buttons (one
 * pressed, one with a menu), a menu button's and a context menu's menus,
 * and a page sheet holding a stack of its own. */
function App() {
  const nav = createNavStack<string>(["Root"]);
  const pages = createNavStack<string>(["Sheet root"]);
  const presses = signal(0);
  const last = signal("none");
  const sheet = signal(false);
  return (
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage
          title={route}
          ios={{
            headerRightItems: [
              { key: "add", symbol: "plus", label: "Add item", onPress: () => presses.set(presses() + 1) },
              {
                key: "more",
                symbol: "ellipsis",
                label: "More",
                menu: [
                  { label: "Rename", onSelect: () => last.set("bar:rename") },
                  { label: "Sort", submenu: [{ label: "By name", onSelect: () => last.set("bar:sort-name") }] },
                ],
              },
            ],
          }}
        >
          <View style={{ flex: 1, padding: 16, gap: 16 }}>
            <Text>{`presses:${presses()}`}</Text>
            <Text>{`last:${last()}`}</Text>
            <MenuButton
              testID="menu-button"
              accessibilityLabel="Arrange"
              title="Arrange"
              items={[
                { id: "share", label: "Share" },
                { id: "", label: "Move to", items: [{ id: "move:archive", label: "Archive" }] },
              ]}
              onSelect={({ id }) => last.set(`button:${id}`)}
            >
              <View style={{ padding: 12 }}>
                <Text>Arrange</Text>
              </View>
            </MenuButton>
            <ContextMenu
              items={[
                { id: "star", label: "Star" },
                { id: "delete", label: "Delete", destructive: true },
              ]}
              onSelect={({ id }) => last.set(`context:${id}`)}
              trigger={
                <View testID="note" accessibilityLabel="Note" style={{ padding: 16, borderWidth: 1, borderRadius: 12 }}>
                  <Text>Hold for actions</Text>
                </View>
              }
            />
            <View role="button" testID="open-sheet" onPress={() => sheet.set(true)} style={{ padding: 12 }}>
              <Text>Open sheet</Text>
            </View>
            <Dialog
              open={sheet()}
              presentation="pageSheet"
              accessibilityLabel="Sheet"
              onOpenChange={({ open }) => {
                if (!open) {
                  sheet.set(false);
                  pages.popToRoot();
                }
              }}
              style={{ flex: 1 }}
            >
              <NavStack state={pages} style={{ flex: 1 }}>
                {(page) => (
                  <NavPage title={page}>
                    <View style={{ flex: 1, padding: 16, gap: 16 }}>
                      <Text>{`Sheet page: ${page}`}</Text>
                      <View role="button" testID="push" onPress={() => pages.push("Detail")} style={{ padding: 12 }}>
                        <Text>Push</Text>
                      </View>
                    </View>
                  </NavPage>
                )}
              </NavStack>
            </Dialog>
          </View>
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
