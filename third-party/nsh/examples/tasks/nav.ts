// The navigation stack's state, created once; pages import it to navigate.
import { createNavStack } from "nsh/base";

export type Route = { name: "tasks" } | { name: "task"; id: number };

export const nav = createNavStack<Route>([{ name: "tasks" }]);
