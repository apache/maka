import { lazy } from "../ui";

const Actions = lazy(() => import("./StandardActions").then((module) => module.StandardActions));

/** Exercises the host's standard modules through the same API on every platform. */
export function Standard() {
  return <Actions />;
}

export { Standard as StandardDemo };
