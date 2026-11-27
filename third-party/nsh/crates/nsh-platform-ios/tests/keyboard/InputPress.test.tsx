// A tap on an input's text or padding is the input's press when it
// listens, after the focus the tap gives it (a combobox opens its list on
// it), and no view around it hears a press, as on the other platforms. A
// drag or a touch held on the text is the field's (the caret, a selection,
// the edit menu), not a press.
import { expect, open, test } from "nsh/test";

test("a tap on an input presses it after its focus, and not the row around it", async () => {
  const app = await open("./InputPress.tsx");
  await app.press("id:field");
  await app.waitFor("text:log:focus field,press field");
  // A second tap, on the focused field's padding.
  await app.press("id:field", { position: { x: 3, y: 20 } });
  await app.waitFor("text:log:focus field,press field,press field");
  // The text area, on its padding.
  await app.press("id:area", { position: { x: 3, y: 36 } });
  await app.waitFor("text:log:focus field,press field,press field,focus area,press area");
  await app.wait(300);
  expect(app.shows("text:log:focus field,press field,press field,focus area,press area")).toBe(true);
});

test("an input that does not listen leaves the tap to no one", async () => {
  const app = await open("./InputPress.tsx");
  // A real touch: `press` needs a pressable view.
  await app.drag("id:quiet", { x: 0, y: 0 });
  await app.waitFor("text:log:focus quiet");
  await app.wait(300);
  expect(app.shows("text:log:focus quiet")).toBe(true);
});

test("a drag or a touch held on an input's text is no press", async () => {
  const app = await open("./InputPress.tsx");
  await app.press("id:field");
  await app.waitFor("text:log:focus field,press field");
  await app.drag("id:field", { x: 60, y: 0 });
  await app.longPress("id:field");
  await app.wait(300);
  expect(app.shows("text:log:focus field,press field")).toBe(true);
});
