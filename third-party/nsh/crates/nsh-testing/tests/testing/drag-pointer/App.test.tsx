import { expect, open, test } from "nsh/test";

test("on a phone a finger drags: its touches say so, and it scrolls the list", async () => {
  const app = await open("./App.tsx");
  await app.drag("id:row", { y: -300 });
  expect(app.shows("Pointer: touch")).toBe(true);
  expect(app.shows("Scrolled: yes")).toBe(true);
});

test("on a desktop the mouse drags: its touches say so, and it scrolls no list", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:row", { y: -300 });
  expect(app.shows("Pointer: mouse")).toBe(true);
  expect(app.shows("Scrolled: no")).toBe(true);
});

test("the web drags with the mouse at a phone's width too", async () => {
  const app = await open("./App.tsx", { platform: "web", width: 390, height: 844 });
  await app.drag("id:row", { y: -300 });
  expect(app.shows("Pointer: mouse")).toBe(true);
  expect(app.shows("Scrolled: no")).toBe(true);
});
