# The TSX application recipe

A complete small app: its files follow the [Coding Guides](coding-guides.md) (`App.tsx` the
shell, `pages/` one file per `NavPage`, `components/` what pages share, `store.ts` the state).
This is `examples/tasks` in `longbridge/nsh`, and CI builds and tests that app.

What to notice:

- `store.ts` keeps its signal private: pages read and change it through functions.
- `TaskDetail` reads `task()` through a closure, so it follows the store and survives removal.
- `TaskList`'s row keeps no state: a cell is given other rows as it is reused.
- Each page has a `title` for the system header and a `header` for the desktops and the web.
- Colors are theme tokens, and sizes the Tailwind scale.
- The test takes a user's steps, and answers the system alert with `onDialog`.

## `nsh.json`

```json
{
  "name": "Tasks",
  "id": "com.example.tasks"
}
```

## `store.ts`

```ts
// The app's state: its signal stays private, pages read and change it through these functions.
import { signal } from "nsh";

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

const tasks = signal<Task[]>([
  { id: 1, title: "Read the coding guides", done: true },
  { id: 2, title: "Write the first page", done: false },
]);
let nextId = 3;

/** Every task (tracked where it is read). */
export const allTasks = () => tasks();

/** One task, or undefined once it is removed (tracked where it is read). */
export const taskById = (id: number) => tasks().find((task) => task.id === id);

/** Adds a task; a blank title adds nothing. */
export function addTask(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  tasks.update((list) => [...list, { id: nextId++, title: trimmed, done: false }]);
}

/** Sets whether a task is done: a new array, a new object for the changed task. */
export function setTaskDone(id: number, done: boolean) {
  tasks.update((list) => list.map((task) => (task.id === id ? { ...task, done } : task)));
}

/** Removes a task. */
export function removeTask(id: number) {
  tasks.update((list) => list.filter((task) => task.id !== id));
}
```

## `nav.ts`

```ts
// The navigation stack's state, created once; pages import it to navigate.
import { createNavStack } from "nsh/base";

export type Route = { name: "tasks" } | { name: "task"; id: number };

export const nav = createNavStack<Route>([{ name: "tasks" }]);
```

## `App.tsx`

```tsx
// The app shell: the root and the navigation stack, no page logic.
import { mount, View } from "nsh";
import { NavStack } from "nsh/base";
import { nav } from "./nav";
import { TaskDetail } from "./pages/TaskDetail";
import { TaskList } from "./pages/TaskList";

function App() {
  return (
    <View class="flex-1 bg-background">
      <NavStack state={nav} class="flex-1">
        {(route) => {
          switch (route.name) {
            case "tasks":
              return <TaskList />;
            case "task":
              return <TaskDetail id={route.id} />;
          }
        }}
      </NavStack>
    </View>
  );
}

mount(App);
```

## `components/Header.tsx`

```tsx
// The page's header on the desktops and the web; iOS and Android show the system's, from the page's `title`.
import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { nav } from "../nav";

export function Header(props: { title: string }) {
  return (
    <View class="flex-row items-center gap-3 border-b border-border p-3">
      <If when={nav.routes().length > 1}>
        <Button onPress={() => nav.pop()} class="active:opacity-60">
          <Text class="text-primary">Back</Text>
        </Button>
      </If>
      <Text class="font-semibold text-foreground">{props.title}</Text>
    </View>
  );
}
```

## `pages/TaskList.tsx`

```tsx
// A page: a native text input and a virtualized list over the store's tasks.
import { List, signal, Text, View } from "nsh";
import { Button, Input, NavPage } from "nsh/base";
import { Header } from "../components/Header";
import { nav } from "../nav";
import { addTask, allTasks } from "../store";

export function TaskList() {
  // Transient view state belongs to the page that renders it.
  const draft = signal("");
  const submit = () => {
    addTask(draft());
    draft.set("");
  };
  return (
    <NavPage title="Tasks" header={<Header title="Tasks" />}>
      <View class="flex-1 gap-3 p-4 pb-[env(safe-area-inset-bottom)]">
        <View class="flex-row items-center gap-2">
          <Input
            value={draft()}
            onChange={({ value }) => draft.set(value)}
            onSubmit={submit}
            placeholder="New task"
            class="flex-1 rounded-(--radius) border border-input px-3 py-2 text-foreground"
          />
          <Button
            disabled={!draft().trim()}
            onPress={submit}
            class="rounded-(--radius) bg-primary px-4 py-2 active:opacity-60 disabled:opacity-40"
          >
            <Text class="text-primary-foreground">Add</Text>
          </Button>
        </View>
        <List each={allTasks()} keyExtractor={(task) => String(task.id)} estimatedItemSize={48} class="flex-1">
          {/* A cell shows other rows as it is reused: read the item where it is used, keep no state here. */}
          {(task) => (
            <Button
              onPress={() => nav.push({ name: "task", id: task().id })}
              class="flex-row items-center justify-between p-3 active:bg-muted"
            >
              <Text class="text-foreground">{task().title}</Text>
              <Text class="text-muted-foreground">{task().done ? "Done" : "Open"}</Text>
            </Button>
          )}
        </List>
      </View>
    </NavPage>
  );
}
```

## `pages/TaskDetail.tsx`

```tsx
// A page: a controlled switch, and a system alert before a removal that cannot be undone.
import { Text, View } from "nsh";
import { AlertDialog, Button, NavPage, Switch } from "nsh/base";
import { Header } from "../components/Header";
import { nav } from "../nav";
import { removeTask, setTaskDone, taskById } from "../store";

export function TaskDetail(props: { id: number }) {
  // A closure, so the task is read where it is used and follows the store.
  const task = () => taskById(props.id);
  const confirmRemove = async () => {
    const { action } = await AlertDialog.show({
      title: "Remove this task?",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "remove", label: "Remove", role: "destructive" },
      ],
    });
    if (action !== "remove") return;
    nav.pop();
    removeTask(props.id);
  };
  return (
    <NavPage title="Task" header={<Header title="Task" />}>
      <View class="flex-1 gap-4 p-4 pb-[env(safe-area-inset-bottom)]">
        <Text class="text-lg text-foreground">{task()?.title}</Text>
        <Switch
          checked={task()?.done ?? false}
          onChange={({ checked }) => setTaskDone(props.id, checked)}
          class="flex-row items-center gap-3"
          trackClass="w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary"
          thumbClass="size-5 rounded-full bg-background transition-transform checked:translate-x-5"
        >
          <Text class="text-foreground">Done</Text>
        </Switch>
        <Button onPress={confirmRemove} class="self-start rounded-(--radius) border border-destructive px-4 py-2 active:opacity-60">
          <Text class="text-destructive">Remove</Text>
        </Button>
      </View>
    </NavPage>
  );
}
```

## `App.test.tsx`

```tsx
// The app's flows, with the steps a user takes.
import { expect, open, test } from "nsh/test";

test("adds a task, and a blank title cannot be added", async () => {
  const app = await open("./App.tsx");
  expect(app.enabled("role:button[Add]")).toBe(false);
  await app.type("text:New task", "Ship it");
  await app.press("role:button[Add]");
  await app.waitFor("Ship it");
  expect(app.value("text:New task")).toBe("");
});

test("a task's switch changes the list behind it", async () => {
  const app = await open("./App.tsx");
  await app.press("Write the first page");
  await app.waitFor("role:switch");
  await app.press("role:switch");
  await app.back();
  await app.waitFor("role:button[Write the first page Done]");
});

test("removing asks first, and only Remove removes", async () => {
  const app = await open("./App.tsx");
  await app.press("Read the coding guides");
  await app.waitFor("role:button[Remove]");
  app.onDialog((dialog) => {
    expect(dialog.title).toBe("Remove this task?");
    return "Remove";
  });
  await app.press("role:button[Remove]");
  await app.waitFor("Read the coding guides", { state: "gone" });
  expect(app.dialogs().length).toBe(1);
});
```
