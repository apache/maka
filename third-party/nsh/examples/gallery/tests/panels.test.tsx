// Presses and typing land in a dialog or sheet shown after the app starts,
// and in a sheet shown from a dialog, as a finger's would.
import { open, test } from "nsh/test";

test("a press on a row at the top of a list in a page sheet lands on it", async () => {
  const app = await open("./fixtures/panels.tsx");
  await app.press("text:Open dialog");
  await app.type("id:search", "a");
  await app.waitFor("id:people >> text:Alice");
  await app.press("id:people >> text:Alice");
  await app.waitFor("text:picked: Alice");
});

test("typing lands in a sheet shown from a page sheet", async () => {
  const app = await open("./fixtures/panels.tsx");
  await app.press("text:Open dialog");
  await app.press("text:Invite");
  await app.type("id:invite-input", "hi");
  await app.waitFor("text:invite: hi");
});

test("typing lands in a sheet", async () => {
  const app = await open("./fixtures/panels.tsx");
  await app.press("text:Open sheet");
  await app.type("id:sheet-input", "ok");
  await app.waitFor("text:note: ok");
});
