import { expect, open, test } from "nsh/test";

test("a child tracking pressed styles lets its ancestor handle the click", async () => {
  const app = await open("./fixtures/press.tsx");
  await app.press("Styled child");
  await app.waitFor("Outer 1");
  await app.press("Styled child");
  await app.waitFor("Outer 2");
  expect(app.texts()).toContain("Inner 0");
});

test("a child with its own click handler takes the click before its ancestor", async () => {
  const app = await open("./fixtures/press.tsx");
  await app.press("Clickable child");
  await app.waitFor("Inner 1");
  expect(app.texts()).toContain("Outer 0");
});


test("styled text and image children let their ancestor handle the click", async () => {
  const app = await open("./fixtures/press.tsx");
  await app.press("Styled text");
  await app.waitFor("Outer 1");
  await app.press("label:Styled image");
  await app.waitFor("Outer 2");
});

test("a child with Android ripple feedback lets its ancestor handle the click", async () => {
  const app = await open("./fixtures/press.tsx");
  await app.press("Ripple child");
  await app.waitFor("Outer 1");
});
