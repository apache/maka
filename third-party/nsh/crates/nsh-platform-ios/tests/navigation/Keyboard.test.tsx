// The root observes system-delivered touches. Blur must arrive while the
// finger is still down, before UIKit finishes popping and detaches Input.
import { expect, open, test } from "nsh/test";

for (const name of ["Hidden header", "Visible header", "Multiline editor"]) {
  test(`an accepted swipe blurs the editor during dragging with ${name.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await app.press(`text:${name}`);
    await app.wait(600);
    await app.type("id:editor", "A draft");
    await app.waitFor("focused:true blurDuringDrag:false");
    await app.drag("id:edge", { x: 300, y: 0 });
    await app.waitFor("depth:1");
    expect(app.shows("focused:false blurDuringDrag:true")).toBe(true);
  });
}

for (const name of ["Swipe disabled", "Back disabled"]) {
  test(`a rejected swipe keeps the editor focused with ${name.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await app.press(`text:${name}`);
    await app.wait(600);
    await app.type("id:editor", "A draft");
    await app.drag("id:edge", { x: 300, y: 0 });
    await app.wait(600);
    expect(app.shows("depth:2")).toBe(true);
    expect(app.shows("focused:true blurDuringDrag:false")).toBe(true);
  });
}

test("root and non-back drags keep the editor focused", async () => {
  const app = await open("./App.tsx");
  await app.type("id:editor", "Root draft");
  await app.drag("id:edge", { x: 300, y: 0 });
  expect(app.shows("depth:1")).toBe(true);
  expect(app.shows("focused:true blurDuringDrag:false")).toBe(true);
  await app.press("text:Hidden header");
  await app.wait(600);
  await app.type("id:editor", "A draft");
  await app.drag("id:content", { x: 0, y: 120 });
  await app.drag("id:content", { x: -80, y: 0 });
  expect(app.shows("focused:true blurDuringDrag:false")).toBe(true);
});

test("cancelling a short swipe restores the same editor", async () => {
  const app = await open("./App.tsx");
  await app.press("text:Hidden header");
  await app.wait(600);
  await app.type("id:editor", "A draft");
  await app.drag("id:edge", { x: 60, y: 0 });
  await app.wait(700);
  expect(app.shows("depth:2")).toBe(true);
  expect(app.shows("focused:true blurDuringDrag:true")).toBe(true);
  expect(app.value("id:editor")).toBe("A draft");
});
