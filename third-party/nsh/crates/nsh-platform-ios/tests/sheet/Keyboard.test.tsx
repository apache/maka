import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function edit(app: App) {
  await app.press("text:Editing");
  await app.waitFor("Sheet body");
  await app.wait(450);
  await app.type("id:field", "A draft");
  await app.waitFor("text:editing:true");
}

test("scrolling the list inside keeps the keyboard", async () => {
  const app = await open("./App.tsx");
  await edit(app);
  await app.drag("id:scroll", { x: 0, y: -160 });
  await app.wait(450);
  expect(app.shows("text:scroll:0")).toBe(false);
  await app.drag("id:scroll", { x: 0, y: 100 });
  await app.wait(450);
  expect(app.shows("text:editing:true")).toBe(true);
  expect(app.shows("text:closed:0 reason:none cancel:0")).toBe(true);
});

test("dragging the panel down ends editing", async () => {
  const app = await open("./App.tsx");
  await edit(app);
  await app.drag("id:handle", { x: 0, y: 30 });
  await app.waitFor("text:editing:false");
  await app.wait(450);
  expect(app.shows("text:closed:0 reason:none cancel:0")).toBe(true);
  expect(app.value("id:field")).toBe("A draft");
});

test("a list at its top hands the drag to the panel, which ends editing", async () => {
  const app = await open("./App.tsx");
  await edit(app);
  await app.drag("id:scroll", { x: 0, y: 260 });
  await app.waitFor("text:closed:1 reason:swipe cancel:1");
  expect(app.shows("text:editing:false")).toBe(true);
});
