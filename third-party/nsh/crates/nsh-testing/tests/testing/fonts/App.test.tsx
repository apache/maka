import { open, test } from "nsh/test";

test("a font registered while the app runs names its family", async () => {
  const app = await open("./App.tsx");
  await app.press("id:url");
  await app.waitFor("Family: Pacifico");
});

test("data that is no font is refused", async () => {
  const app = await open("./App.tsx");
  await app.press("id:bytes");
  await app.waitFor("Family: refused (true)");
});

test("a font that does not load is refused", async () => {
  const app = await open("./App.tsx");
  await app.press("id:missing");
  await app.waitFor("Family: refused (true)");
});
