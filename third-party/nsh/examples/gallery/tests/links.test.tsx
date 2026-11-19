// Spans of a text that take presses (a nested `<Text onPress>`): found by
// their characters, pressed where they are drawn.
import { expect, open, test } from "nsh/test";

test("the links of a sentence take their own presses", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Text");
  await app.waitFor("Spans and links");
  expect(app.shows("nothing yet")).toBe(true);
  await app.press("Privacy policy");
  await app.waitUntil(() => app.texts().includes("Privacy policy"));
  await app.press("text:links");
  await app.waitFor("a link inside bold text");
  await app.longPress("Terms of service");
  await app.waitFor("Terms (long press)");
  // The span's characters are not texts of their own.
  expect(app.texts().filter((t) => t === "Terms of service")).toEqual([]);
});

test("a link a truncated line hides takes no press, one it cuts takes them on what shows", async () => {
  const app = await open("./fixtures/link-truncated.tsx");
  // The web's for now (a headless run draws nothing; Linux and Windows
  // still give the ellipsis to the hidden link).
  if (!app.shows("Platform: web")) return;
  // None of the hidden link's characters are drawn: the press finds none.
  // The ellipsis standing for it is no link's either: the web text
  // engine's own tests check that in its layout.
  await app.press("MMMMMMMM").catch(() => {});
  await app.wait(200);
  expect(app.shows("Hidden link pressed: 0")).toBe(true);
  // The cut link's first characters are drawn, and they are the link's.
  await app.press("WWWWWWWWWW");
  await app.waitFor("Cut link pressed: 1");
  expect(app.shows("Hidden link pressed: 0")).toBe(true);
});
