// A press on a view a scroll view hides, partly or wholly, scrolls it into
// view first. The scroll moves straight to it, without a fling past it that
// has to be undone, along either axis, and leaves a view already in full
// view where it is.
import { expect, open, test } from "nsh/test";

test("a chip half hidden at the row's end scrolls into view once and is pressed", async () => {
  const app = await open("./App.tsx");
  await app.press("id:chip-4");
  await app.waitFor("text:pressed:Chip 4");
  expect(app.shows("text:x:0 turns:0")).toBe(false);
  expect(app.count("text:/turns:0$/")).toBe(2);
});

test("a chip far along the row scrolls into view, and back, without turning", async () => {
  const app = await open("./App.tsx");
  await app.press("id:chip-10");
  await app.waitFor("text:pressed:Chip 10");
  await app.press("id:chip-1");
  await app.waitFor("text:pressed:Chip 1");
  // One turn: from going on to going back.
  expect(app.count("text:/^x:\\d+ turns:1$/")).toBe(1);
});

test("a row far down scrolls into view without turning", async () => {
  const app = await open("./App.tsx");
  await app.press("text:Row 30");
  await app.waitFor("text:pressed:Row 30");
  expect(app.count("text:/^y:\\d+ turns:0$/")).toBe(1);
  expect(app.shows("text:y:0 turns:0")).toBe(false);
});

test("a view in full view is pressed where it is", async () => {
  const app = await open("./App.tsx");
  await app.press("id:chip-2");
  await app.waitFor("text:pressed:Chip 2");
  await app.press("text:Row 3");
  await app.waitFor("text:pressed:Row 3");
  expect(app.shows("text:x:0 turns:0")).toBe(true);
  expect(app.shows("text:y:0 turns:0")).toBe(true);
});

for (const [scroller, axis] of [["chips", "x"], ["rows", "y"]]) {
  test(`a scroll moves ${scroller} as far as the finger, with no fling after it`, async () => {
    const app = await open("./App.tsx");
    await app.scroll(`id:${scroller}`, 160);
    await app.wait(800);
    // The finger moves 160 points; the scroll view starts to follow it
    // a few points in.
    const at = app.texts().find((t) => t.startsWith(`${axis}:`))!;
    const offset = Number(at.slice(2).split(" ")[0]);
    expect(offset > 120 && offset <= 160).toBe(true);
  });
}
