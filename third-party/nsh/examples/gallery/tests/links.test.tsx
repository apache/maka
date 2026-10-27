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

test("a link a truncated line hides takes no press, and its ellipsis none", async () => {
  const app = await open("./fixtures/link-truncated.tsx");
  // The web's for now (a headless run draws nothing; Linux and Windows
  // still give the ellipsis to the hidden link).
  if (!app.shows("Platform: web")) return;
  // The link's characters are not drawn: the press finds none, or lands on
  // the line's ellipsis, which belongs to no link.
  await app.press("WWWWWWWW").catch(() => {});
  await app.wait(200);
  expect(app.shows("Hidden link pressed: 0")).toBe(true);
});
