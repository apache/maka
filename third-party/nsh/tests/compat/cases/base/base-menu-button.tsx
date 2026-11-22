// A case of the API's test suite (docs/dev/compatibility.md): `nsh/base`'s
// `MenuButton`, the system's menu on a trigger of the app's own, on the
// headless runtime, which is iOS: the app's content (its children) shows
// in the frame its style gives, covered by the system's button that holds
// the menu, given as data (`items`: ids, labels, SF Symbols, checks,
// disabled and destructive items, submenus and inline sections), its
// `title`, `disabled` and `accessibilityLabel`; `onSelect({ id })` reports
// the chosen item (the platform's event, which the engine's tests send).
// A `ContextMenu` given `items` is the system's context menu there: a held
// finger is the system's to answer, and the children (the drawn menu of
// the other platforms) never show.
import { Text, View, signal } from "nsh";
import { ContextMenu, MenuButton, MenuItem } from "nsh/base";

function App() {
  const dark = signal(false);
  const chosen = signal("none");
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <MenuButton
        testID="menu-button"
        accessibilityLabel="Account"
        title="me@example.com"
        items={[
          { id: "settings", label: "Settings", icon: "gearshape" },
          { id: "read", label: "Mark all as read", disabled: true },
          { id: "", label: "Language", items: [
            { id: "en", label: "English", checked: true },
            { id: "zh", label: "中文", checked: false },
          ] },
          { id: "", label: "Appearance", inline: true, items: [
            { id: "light", label: "Light", checked: !dark() },
            { id: "dark", label: "Dark", checked: dark() },
          ] },
          { id: "", label: "", inline: true, items: [{ id: "sign-out", label: "Sign out", destructive: true }] },
        ]}
        onSelect={({ id }) => { chosen.set(id); if (id === "dark") dark.set(true); }}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 44, paddingHorizontal: 12 }}
      >
        <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#d0d0d0" }} />
        <Text>Account trigger</Text>
      </MenuButton>
      <Text>{`Chosen: ${chosen()}`}</Text>
      <ContextMenu
        title="Notes.txt"
        items={[
          { id: "pin", label: "Pin", icon: "pin" },
          { id: "", label: "", inline: true, items: [{ id: "delete", label: "Delete", destructive: true }] },
        ]}
        onSelect={({ id }) => chosen.set(id)}
        trigger={<View style={{ height: 30 }}><Text>NoteRow</Text></View>}
      >
        <MenuItem><Text>DrawnPin</Text></MenuItem>
      </ContextMenu>
    </View>
  );
}

export default App;
