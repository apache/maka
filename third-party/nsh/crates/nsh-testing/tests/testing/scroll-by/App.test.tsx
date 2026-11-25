import { expect, open, test } from "nsh/test";

// A desktop, for a mouse to point with.
const OPTIONS = { platform: "macos", width: 760, height: 720 } as const;

/** Where the pointer finds the top of row `row`'s avatar, and where its
 * `measure()` puts it. */
async function point(app: Awaited<ReturnType<typeof open>>, row: number) {
  await app.hover("id:jump");
  await app.hover(`id:avatar-${row}`);
  let line = "";
  await app.waitUntil(() => {
    line = app.texts().find((t) => t.startsWith(`row ${row}:`)) ?? "";
    return line !== "";
  });
  const [pointer, measured] = line.slice(line.indexOf(":") + 1).split(",").map(Number);
  return { pointer, measured };
}

test("measure() takes in the scrolls that keep a list's rows in place", async () => {
  const app = await open("./App.tsx", OPTIONS);
  await app.press("id:jump");
  await app.waitFor("id:avatar-21");
  const before = await point(app, 21);
  expect(before.measured).toBe(before.pointer);
  // The rows above grow: the core scrolls by as much as they grew in sight
  // (`ScrollBy`), so row 21 stays where it was.
  await app.press("id:grow");
  const after = await point(app, 21);
  expect(after.pointer).toBe(before.pointer);
  expect(after.measured).toBe(after.pointer);
});
