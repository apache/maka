import { type JSX, signal } from "nsh";
import { createNavStack } from "nsh/base";
import type { IconName } from "./icons";

/** A demo of the index. */
export interface DemoEntry {
  name: string;
  detail: string;
  icon: IconName;
  screen: () => JSX.Element;
}

/** A screen a demo pushes: a component rendering its own `<NavPage>`. */
export type Route = { name: "home" } | { name: "demo"; demo: DemoEntry } | { name: "page"; page: () => JSX.Element };

export const nav = createNavStack<Route>([{ name: "home" }]);

/** The demo shown (the desktop layout's selection, the phone's pushed demo):
 * its page reads the name and what it shows for its header. */
export const shownDemo = signal<DemoEntry | null>(null);
