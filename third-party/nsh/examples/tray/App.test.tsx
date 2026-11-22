// The tray's icon and menu are the system's, which a test does not click:
// the test checks the window the app starts with.
import { expect, open, test } from "nsh/test";

test("starts with only its tray icon: the window is made, hidden", async () => {
  const app = await open("./App.tsx", { platform: "macos", width: 300, height: 280 });
  expect(app.window("main").state()).toMatchObject({ visible: false, focused: false, minimized: false });
});
