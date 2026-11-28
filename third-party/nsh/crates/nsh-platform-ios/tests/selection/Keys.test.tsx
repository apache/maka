// Run with `nsh test crates/nsh-platform-ios/tests/selection --target ios`
// (a simulator with the hardware keyboard connected).
import { type App, expect, open, test } from "nsh/test";

async function select(app: App) {
  await app.longPress("text:Select these words then type");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("selected:") && t.length > 9));
}

test("keys typed over a selection reach the ancestors' onKeyDown and onKeyUp", async () => {
  const app = await open("./Keys.tsx");
  await select(app);
  await app.keyboard.press("a");
  await app.waitFor("text:down:a");
  await app.waitFor("text:up:a");
  expect(app.shows("text:prevented:false")).toBe(true);
  await app.keyboard.press("b");
  await app.waitFor("text:down:b");
  await app.keyboard.press("right");
  await app.waitFor("text:down:ArrowRight");
  await app.waitFor("text:up:ArrowRight");
  // The keys leave the selection alone.
  expect(app.texts().some((t) => t.startsWith("selected:") && t.length > 9)).toBe(true);
});

test("a capture rule around the selectable view takes the key", async () => {
  const app = await open("./Keys.tsx");
  await select(app);
  await app.keyboard.press("x");
  await app.waitFor("text:down:x");
  expect(app.shows("text:prevented:true")).toBe(true);
});

test("command-a and command-c still select all and copy", async () => {
  const app = await open("./Keys.tsx");
  await select(app);
  await app.keyboard.press("mod+a");
  await app.waitFor("text:selected:Select these words then type");
  await app.keyboard.press("mod+c");
  await app.clear("id:paste");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => app.value("id:paste") === "Select these words then type");
});
