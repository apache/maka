// The Form demo: its fields, leaving or submitting checks them, the
// password's strength follows the text, the dismiss modes and the sheet
// change what it shows, the message bar sends, keys show as chips.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Form");
});

test("shows its fields", () => {
  for (const text of [
    "Keyboard",
    "keyboardDismissMode while dragging",
    "0 pt",
    "Drag the form with the keyboard up",
    "on-drag",
    "Account",
    "autoComplete",
    "E-mail",
    "email-address",
    "Empty",
    "Verification code",
    "0/6",
    "Shipping address",
    "0–0",
    '""',
    "Keys you press show here",
    "Notes",
    "0/280",
    "Grows with its text",
    "No caret",
    "caret",
    "Create the account",
    "More keyboards",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("submitting checks the fields, and fixing them creates the account", async () => {
  // An empty form: its three required fields need attention.
  await app.press("Submit");
  for (const text of [
    "3 fields need attention",
    "Check",
    "Enter your name",
    "Enter your e-mail",
    "Use at least 8 characters",
  ]) {
    await app.waitFor(text);
  }
  await app.type("text:Ada Lovelace", "Ada");
  await app.waitFor("Enter your name", { state: "gone" });
  await app.type("text:ada@example.com", "ada@x");
  await app.waitFor("That address needs an @ and a domain");
  await app.clear("text:ada@x");
  await app.type("text:ada@example.com", "ada@example.com");
  // The strength follows the password: three letters are not even weak.
  await app.type("text:At least 8 characters", "abc");
  expect(app.texts()).toContain("Empty");
  await app.type("text:abc", "defgh");
  await app.waitFor("Weak");
  await app.clear("text:abcdefgh");
  await app.type("text:At least 8 characters", "Abcdefg1!");
  await app.waitFor("Strong");
  await app.press("Submit");
  await app.waitFor("Account created for Ada <ada@example.com>");
  expect(app.texts()).toContain("Sent");
});

test("leaving the name empty flags it", async () => {
  await app.press("Interactive");
  await app.waitFor("interactive");
  // Return leaves the field.
  await app.submit("text:Ada Lovelace");
  await app.waitFor("Enter your name");
});

test("opens the sheet of inputs and closes it", async () => {
  await app.press("Inputs in a sheet");
  await app.waitFor("A sheet");
  expect(app.texts()).toContain("Seventh");
  await app.press("Done");
  await app.waitFor("A sheet", { state: "gone" });
});

test("the message bar sends what is typed", async () => {
  await app.press("A message bar at the bottom");
  for (const text of [
    "Today",
    "The bar below sits outside the scroll view.",
    "Its bottom padding, env(keyboard-inset-height), lifts it with the keyboard. Say something.",
  ]) {
    await app.waitFor(text);
  }
  await app.type("text:Message", "Hello there");
  await app.submit("text:Hello there");
  // Sent: a message, and the bar empty again.
  await app.waitFor("Hello there");
  expect(app.value("text:Message")).toBe("");
});

test("the keys pressed show as chips", async () => {
  await app.type("text:Select part of this text", "a");
  await app.waitFor("Keys you press show here", { state: "gone" });
  expect(app.value("text:Select part of this texta")).toBe("Select part of this texta");
});
