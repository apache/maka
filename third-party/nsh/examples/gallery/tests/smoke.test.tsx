// The smoke set a pull request runs on a real platform (`nsh test --target
// macos|web`, `.github/workflows/macos.yml`, `rust-app.yml`): typing, the
// focus a press gives, the keymap's shortcuts. Each case is a regression a
// platform once had while headless runs passed. Keep it small: it runs on
// every pull request that touches a platform.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 500, height: 220 } as const;

test("typing goes to the input pressed, whatever the press restacks", async () => {
  const app = await open("./fixtures/smoke-restack-focus.tsx", desktop);
  await app.type("input-b", "X");
  await app.type("input-a", "Y");
  await app.waitFor("text:a=Y b=X");
  expect(app.texts()).toContain("a=Y b=X");
});

test("the keymap hears undo, redo and select all", async () => {
  const app = await open("./fixtures/smoke-keymap.tsx", desktop);
  await app.keyboard.press("mod+z");
  await app.keyboard.press("mod+shift+z");
  await app.keyboard.press("mod+a");
  await app.waitFor("text:/log: .*mod\\+a/");
  expect(app.texts()).toContain("log: mod+z mod+shift+z mod+a");
});
