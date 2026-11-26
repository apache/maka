import { mount, signal, Text, View } from "nsh";
import { MenuButton } from "nsh/base";

/** Menu buttons whose triggers the app draws: a floating glass pill and a
 * plain bordered button, over content that shows through a menu's glass. */
function App() {
  const last = signal("none");
  const items = [
    { id: "chat", label: "Create in chat", icon: "bubble.left" },
    { id: "form", label: "Create with form", icon: "list.bullet.rectangle" },
  ];
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 80, gap: 16, backgroundColor: "#f2f2f7" }}>
      <Text testID="last">{`last:${last()}`}</Text>
      <MenuButton
        testID="plain"
        accessibilityLabel="Arrange"
        title="Arrange"
        items={[{ id: "name", label: "By name" }, { id: "date", label: "By date" }]}
        onSelect={({ id }) => last.set(`plain:${id}`)}
        style={{ alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: "#007aff", borderRadius: 10 }}
      >
        <Text style={{ color: "#007aff", fontSize: 17 }}>Arrange</Text>
      </MenuButton>
      {Array.from({ length: 8 }, (_, i) => (
        <View style={{ padding: 16, borderRadius: 12, backgroundColor: "#ffffff" }}>
          <Text>{`Scheduled task ${i + 1}`}</Text>
        </View>
      ))}
      <MenuButton
        testID="pill"
        accessibilityLabel="New task"
        items={items}
        onSelect={({ id }) => last.set(`pill:${id}`)}
        style={{
          position: "absolute",
          right: 24,
          bottom: 48,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 20,
          paddingVertical: 14,
          borderRadius: 999,
          glassEffect: "regular",
          backdropFilter: "blur(20px)",
          backgroundColor: "#ff950033",
        }}
      >
        <Text style={{ fontSize: 22, fontWeight: "600", color: "#ff3b30" }}>＋</Text>
        <Text style={{ fontSize: 17, fontWeight: "600", color: "#ff3b30" }}>New task</Text>
      </MenuButton>
    </View>
  );
}

mount(App);
