import { mount, signal, Text, View } from "nsh";
import { button, buttonText, focusRing, hoverFill, Inspector, Panel, size, Stage, ui, wide } from "./palette";

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

let nextId = 4;

function App() {
  const todos = signal<Todo[]>([
    { id: 1, title: "Read the elements page", done: true },
    { id: 2, title: "Try <If> and <Each>", done: false },
    { id: 3, title: "Ship the app", done: false },
  ]);
  const showDone = signal(true);
  const visible = () => (showDone() ? todos() : todos().filter((t) => !t.done));
  const toggle = (id: number) => todos.update((list) => list.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const add = () => todos.update((list) => [...list, { id: nextId++, title: `Task ${nextId - 1}`, done: false }]);
  const remove = (id: number) => todos.update((list) => list.filter((t) => t.id !== id));
  const actions = () => (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <View onPress={add} {...button("accent")}>
        <Text style={buttonText("accent")}>Add</Text>
      </View>
      <View onPress={() => showDone.set(!showDone())} {...button()}>
        <Text style={buttonText()}>{showDone() ? "Hide done" : "Show done"}</Text>
      </View>
    </View>
  );
  const list = () => (
    <If
      when={visible().length > 0}
      else={<Text style={{ color: ui().muted, textAlign: "center", marginTop: 40 }}>Nothing to show.</Text>}
    >
      <View style={{ gap: wide() ? 6 : 8 }}>
        <Each of={visible()} key={(t: Todo) => t.id}>
          {(todo, index) => (
            <View
              style={{
                ...ui().row,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                ...(wide() ? { borderRadius: 8, height: size.row, paddingHorizontal: 12 } : { borderRadius: 12, padding: 12 }),
              }}
            >
              <View
                onPress={() => toggle(todo().id)}
                hitSlop={8}
                style={{
                  width: wide() ? 18 : 22,
                  height: wide() ? 18 : 22,
                  borderRadius: wide() ? 9 : 11,
                  borderWidth: 2,
                  borderColor: ui().accent,
                  backgroundColor: todo().done ? ui().accent : "transparent",
                }}
                hoverStyle={{ opacity: 0.88 }}
                focusStyle={focusRing()}
                activeStyle={{ opacity: 0.7 }}
              />
              <Text
                style={{
                  flex: 1,
                  fontSize: wide() ? size.label : undefined,
                  color: todo().done ? ui().faint : ui().text,
                  textDecorationLine: todo().done ? "line-through" : "none",
                }}
              >
                {index() + 1}. {todo().title}
              </Text>
              <If when={todo().done}>
                <View onPress={() => remove(todo().id)} hitSlop={8} hoverStyle={hoverFill()} focusStyle={focusRing()} activeStyle={{ opacity: 0.7 }}>
                  <Text style={{ color: ui().down, fontSize: wide() ? 13 : undefined }}>Remove</Text>
                </View>
              </If>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
  const counts = () => `${todos().filter((t) => t.done).length} of ${todos().length} done`;

  return (
    <View style={{ flex: 1, backgroundColor: ui().page }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, padding: 20, paddingTop: 24, gap: 14 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>if / each</Text>
            <Text style={{ color: ui().muted }}>Click a circle to finish a task; Remove shows on finished ones</Text>
            <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
              <Stage width={420}>
                {/* A fixed height, so the list grows downwards instead of moving. */}
                <View style={{ height: 360 }}>{list()}</View>
              </Stage>
              <Inspector>
                {actions()}
                <Panel title="todos · showDone">
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>{counts()}</Text>
                  <Text style={{ fontSize: 13, color: ui().text }}>
                    {showDone() ? "every task shown" : `${visible().length} not done shown`}
                  </Text>
                </Panel>
              </Inspector>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, width: "100%", maxWidth: 560, alignSelf: "center", padding: 20, paddingTop: 24, gap: 12 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>if / each</Text>
            {actions()}
            {list()}
            <Text style={{ fontSize: 12, color: ui().muted, fontVariant: ["tabular-nums"] }}>{counts()}</Text>
          </View>
        )
      }
    </View>
  );
}

mount(App);
