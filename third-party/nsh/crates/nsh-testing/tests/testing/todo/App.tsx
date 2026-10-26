import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Storage } from "nsh";

function App() {
  const todos = signal<string[]>([]);
  const draft = signal("");
  const quote = signal("");
  Storage.getItem("todos").then((saved) => todos.set(JSON.parse(saved ?? "[]")));
  fetch("https://api.test/quote")
    .then((r) => r.json())
    .then((q) => quote.set(q.text))
    .catch(() => quote.set("offline"));
  const add = () => {
    if (!draft()) return;
    const next = [...todos(), draft()];
    todos.set(next);
    draft.set("");
    Storage.setItem("todos", JSON.stringify(next));
  };
  return (
    <View style={{ flex: 1 }}>
      <Text>{quote()}</Text>
      <Input
        testID="new-todo"
        placeholder="What to do?"
        value={draft()}
        onChange={(text) => draft.set(text)}
        onSubmit={add}
      />
      <View onPress={add}>
        <Text>Add</Text>
      </View>
      <Each of={todos()}>{(todo) => <Text>{todo()}</Text>}</Each>
      <Text>{`${todos().length} left`}</Text>
    </View>
  );
}

mount(App);
