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
