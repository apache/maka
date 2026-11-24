import { mount, signal, Text, View } from "nsh";
import { ContextMenu, MenuButton } from "nsh/base";

/** The menus Android shows for the app in windows of their own: a menu
 * button's (with a submenu and a disabled item) and a context menu's. */
function App() {
  const last = signal("none");
  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text>{`last:${last()}`}</Text>
      <MenuButton
        testID="menu-button"
        accessibilityLabel="Arrange"
        title="Arrange"
        items={[
          { id: "share", label: "Share" },
          { id: "", label: "Move to", items: [{ id: "move:archive", label: "Archive" }] },
          { id: "locked", label: "Locked", disabled: true },
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
    </View>
  );
}

mount(App);
