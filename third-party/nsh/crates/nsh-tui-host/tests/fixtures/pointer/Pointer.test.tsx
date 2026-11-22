import { expect, open, test } from "nsh/test";

const viewport = { width: 1200, height: 960 };

test("the unchanged Physics demo receives a native pan release", async () => {
  const app = await open("./Physics.tsx", viewport);
  await app.waitFor("label:Draggable card");
  const releases = () => app.texts()[app.texts().indexOf("Releases") + 1];
  expect(releases()).toBe("0");
  await app.drag("label:Draggable card", { x: 64, y: 32 });
  await app.waitUntil(() => releases() === "1");
});

test("the unchanged Gestures demo receives both native pan and responder motion", async () => {
  const app = await open("./Gestures.tsx", viewport);
  await app.waitFor("id:photo");
  await app.drag("id:photo", { x: 64, y: 32 });
  await app.waitUntil(() => {
    const texts = app.texts();
    return parseInt(texts[texts.indexOf("Drag") + 1]) >= 64;
  });
  await app.drag("id:ball", { x: 64, y: 0 });
  await app.waitFor("64, 0");
});

test("the unchanged Resizable demo resizes its sidebar on the Cell grid", async () => {
  const app = await open("./Resizable.tsx", viewport);
  await app.waitFor("Sidebar 220 pt");
  await app.drag("label:Resize the sidebar", { x: 64, y: 0 });
  await app.waitUntil(() => app.texts().some(text =>
    text.startsWith("Sidebar ") && Math.abs(parseFloat(text.slice(8)) - 284) <= 8));
  expect(app.texts().some(text => text.startsWith("Last resize: Row: "))).toBe(true);
});
