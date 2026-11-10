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
