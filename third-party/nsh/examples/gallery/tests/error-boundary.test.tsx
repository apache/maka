// An error boundary keeps a failure to its part of the view: a binding or a
// listener that throws shows the fallback there, the rest stays, and the
// fallback's reset renders the part again.
import { expect, open, test } from "nsh/test";

test("a failing binding shows the fallback, and reset renders the view again", async () => {
  const app = await open("./fixtures/error-boundary.tsx");
  await app.waitFor("Hello, ADA");
  await app.press("Forget name");
  await app.waitFor("Failed: cannot read property 'toUpperCase' of undefined");
  expect(app.texts()).toContain("Header");
  expect(app.texts()).not.toContain("Throw");
  await app.press("Try again");
  await app.waitFor("Hello, GRACE");
});

test("a failing listener shows the fallback", async () => {
  const app = await open("./fixtures/error-boundary.tsx");
  await app.press("Throw");
  await app.waitFor("Failed: press failed");
  expect(app.texts()).toContain("Forget name");
});
