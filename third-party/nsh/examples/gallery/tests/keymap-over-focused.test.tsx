// `keymap.bind`'s `overFocused`: a binding that comes before a focused
// component's own, so an app takes a key the editor binds while the editor
// has the focus (`fixtures/keymap-over-focused.tsx`).
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 600, height: 400 } as const;

async function start() {
  const app = await open("./fixtures/keymap-over-focused.tsx", desktop);
  await app.waitFor("text:/runs/");
  return app;
}

const status = (app: Awaited<ReturnType<typeof start>>) => app.texts().find((t) => t.startsWith("runs"));

test("a binding over the focused editor takes its key", async () => {
  const app = await start();
  await app.press("text:select 1");
  // The editor's mod+enter would insert a line below.
  await app.keyboard.press("mod+enter");
  await app.waitFor("text:/runs 1/");
  expect(status(app)).toBe("runs 1 plain 0 lines 1");
  // Its other keys stay its own.
  await app.keyboard.press("mod+a");
  await app.type("id:sql", "select 2");
  expect(app.value("id:sql")).toBe("select 2");
});

test("without it the focused editor's binding wins, as before", async () => {
  const app = await start();
  await app.press("no-over");
  await app.press("text:select 1");
  await app.keyboard.press("mod+enter");
  await app.waitFor("text:/lines 2/");
  expect(status(app)).toBe("runs 0 plain 0 lines 2");
});

test("once the binding goes with the focus, the app's plain one fires", async () => {
  const app = await start();
  await app.press("text:select 1");
  await app.press("blur");
  await app.wait(100);
  await app.keyboard.press("mod+enter");
  await app.waitFor("text:/plain 1/");
  expect(status(app)).toBe("runs 0 plain 1 lines 1");
});
