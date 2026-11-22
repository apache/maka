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
