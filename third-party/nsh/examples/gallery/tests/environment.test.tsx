// The device as the test sets it up: the system's appearance, the window.
import { open, test } from "nsh/test";

test("follows the system's appearance", async () => {
  const app = await open("../App.tsx", { clock: {}, colorScheme: "dark" });
  await app.press("role:button[System]");
  await app.waitFor("Dark scheme");
  await app.setColorScheme("light");
  await app.waitFor("Light scheme");
});

test("shows the window's size as it rotates", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[System]");
  await app.waitFor("text:/390 × 844/");
  await app.setViewport(844, 390);
  await app.waitFor("text:/844 × 390/");
});
