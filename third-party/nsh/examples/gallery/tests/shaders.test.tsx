// Shader effects and transitions: the children drawn through a shader,
// a change wiped through one, the surface in two inks, and a page and a
// dialog that come and go through an iris. Their controls keep working
// under the shader's frames.
import { expect, open, test } from "nsh/test";

test("effects and transitions keep their children's presses", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Shader");
  await app.waitFor("Shader effect");
  await app.press("Pixelate");
  await app.press("Sharpen");
  // A transition shows the new children once it ran.
  expect(app.shows("Morning")).toBe(true);
  await app.press("Next");
  await app.waitFor("Noon");
  await app.wait(800);
  expect(app.shows("Morning")).toBe(false);
  // The whole surface through a shader, and back.
  await app.press("label:Duotone");
  await app.wait(300);
  await app.press("label:Duotone");
}, 90_000);

test("a page and a dialog come and go through their transition shader", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Shader");
  await app.waitFor("Pages and dialogs");
  await app.press("Push a page");
  await app.waitFor("This page came, and goes, through transitionShader");
  await app.wait(800);
  await app.press("Leave the page");
  await app.wait(800);
  expect(app.shows("This page came, and goes, through transitionShader")).toBe(false);
  await app.press("Open a dialog");
  await app.waitFor("Presented through the iris");
  await app.wait(800);
  await app.press("Close");
  await app.wait(800);
  expect(app.shows("Presented through the iris")).toBe(false);
}, 90_000);
