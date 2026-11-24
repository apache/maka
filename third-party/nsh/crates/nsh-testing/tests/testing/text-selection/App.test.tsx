import { expect, open, test } from "nsh/test";

test("a drag with the mouse selects across a selectable view's texts", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:first", { x: 0, y: 17 });
  await app.waitFor('Selected: " beta\\nGamma"');
});

test("a selectable TextView omits list markers from its selection", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("text:one", { x: 0, y: 30 });
  await app.waitFor('Selected: "e\\ntw"');
});

test("a copy across inline views gives their copy texts in place", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:lead", { x: 400, y: 60 });
  await app.waitFor('Selected: " in\\nArea is $x^2$ here.\\nSide $y$ end."');
});

test("a drag outside the selectable view clears its selection", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:first", { x: 0, y: 17 });
  await app.waitFor("Changes: 1");
  await app.drag("id:outside", { x: 20, y: 0 });
  await app.waitFor("Changes: 2");
  expect(app.shows('Selected: ""')).toBe(true);
});

test("clearSelection clears a selectable view's selection", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:first", { x: 0, y: 17 });
  await app.waitFor("Changes: 1");
  await app.press("id:clear");
  await app.waitFor("Changes: 2");
  expect(app.shows('Selected: ""')).toBe(true);
});

test("a finger drag on a phone selects nothing", async () => {
  const app = await open("./App.tsx", { platform: "ios" });
  await app.drag("id:first", { x: 0, y: 17 });
  expect(app.shows("Changes: 0")).toBe(true);
});
