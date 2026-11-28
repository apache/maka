// Run with --target android: `scrollable={false}` stops the page's viewport scrolling, not the touches it hears.
import { open, test } from "nsh/test";

test("a drag over a web view that does not scroll reaches the page, which stays put", async () => {
  const app = await open("./WebViewDrag.tsx");
  await app.waitFor("text:fixed ready");
  await app.drag("id:fixed", { x: 0, y: -200 });
  await app.waitFor("text:fixed moved unscrolled");
});

test("a drag over a web view that scrolls scrolls its page", async () => {
  const app = await open("./WebViewDrag.tsx");
  await app.waitFor("text:scrolling ready");
  await app.drag("id:scrolling", { x: 0, y: -200 });
  await app.waitFor("text:scrolling moved scrolled");
});
