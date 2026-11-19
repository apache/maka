import { expect, open, test } from "nsh/test";

const DESKTOP = { platform: "macos", width: 800, height: 600 } as const;

test("a main window nsh.json starts hidden runs unseen and unfocused", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("text:Main: visible=false focused=false minimized=false");
  expect(app.window("main").state()).toMatchObject({ visible: false, focused: false, minimized: false });
  await app.waitFor("text:Focused: none");
  // Its views are not on screen; the other window's are. (The headless
  // model's: a real platform's test agent finds a hidden window's views too.)
  await app.waitFor("Main button", { state: "gone" });
  await app.press("Tools button");
  await app.waitFor("text:Presses: tools");
});

test("the app shows it, and hides it again", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.press("Show main");
  await app.waitFor("text:/^Main: visible=true /");
  await app.press("Main button");
  await app.waitFor("text:Presses: main");
  await app.press("Hide main");
  await app.waitFor("text:Main: visible=false focused=false minimized=false");
  await app.waitFor("Main button", { state: "gone" });
  await app.press("Focus main");
  await app.waitFor("text:Main: visible=true focused=true minimized=false");
  await app.waitFor("text:Focused: main");
});
