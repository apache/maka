// Inputs: typing goes key by key, so a controlled input's own value and
// `maxLength` apply as on a device.
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("the Input demo", () => {
  // Each test starts on the demo, in an app of its own.
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { clock: {} });
    await app.press("label:Input");
  });

  test("a controlled input shows what the app makes of each key", async () => {
    await app.type("id:shout", "hello");
    expect(app.value("id:shout")).toBe("HELLO");
    await app.clear("id:shout");
    expect(app.value("id:shout")).toBe("");
  });

  test("Shift with a key types its shifted character", async () => {
    await app.type("id:shout", "a");
    await app.keyboard.press("shift+8");
    await app.keyboard.press("shift+2");
    expect(app.value("id:shout")).toBe("A*@");
  });

  test("an input stops at its maxLength", async () => {
    await app.type("id:code", "12345678");
    expect(app.value("id:code")).toBe("123456");
    await app.waitFor("6/6");
  });
});

describe("the sign-up form", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { clock: {} });
    // Tall enough for the whole account section: queries see the window only.
    await app.setViewport(390, 2400);
    await app.press("label:Input");
  });

  test("submitting checks every field, and typing clears an error as it is fixed", async () => {
    await app.press("label:Create account");
    await app.waitFor("3 fields need attention");
    await app.waitFor("Enter your name");
    await app.type("id:name", "Ada");
    await app.waitFor("Enter your name", { state: "gone" });
  });

  test("a valid form waits for the request, then shows the result by the button", async () => {
    await app.type("id:name", "Ada Lovelace");
    await app.type("id:email", "ada@example.com");
    await app.type("id:password", "Analytical1!");
    await app.press("label:Create account");
    await app.waitFor("label:Creating…");
    await app.clock!.runFor(1000);
    await app.waitFor("text:/^Account created for Ada Lovelace/");
  });

  test("the password shows and hides, and its strength follows the rules it meets", async () => {
    await app.type("id:password", "abc1");
    await app.waitFor("Weak");
    await app.press("label:Show the password");
    await app.waitFor("label:Hide the password");
    await app.type("id:password", "DEF!");
    expect(app.value("id:password")).toBe("abc1DEF!");
    await app.waitFor("Strong");
  });
});

describe("the search field", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { clock: {} });
    await app.setViewport(390, 2400);
    await app.press("label:Input");
  });

  // Inside the results: the shipping address's City field has "London" as its placeholder.
  test("results wait for the typing to pause, and the clear button empties it", async () => {
    // A step settles the app's timers, so the pause before the results
    // is the demo's to show; the test checks what comes after it.
    await app.type("id:search", "lon");
    await app.clock!.runFor(400);
    await app.waitFor("id:results >> text:/^London/");
    await app.waitFor("2 found");
    await app.press("label:Clear the search");
    expect(app.value("id:search")).toBe("");
    await app.waitFor("2 found", { state: "gone" });
  });

  test("a search without a match says so", async () => {
    await app.type("id:search", "zzz");
    await app.clock!.runFor(400);
    await app.waitFor("text:/^No city or country matches/");
  });
});

test("a disabled field takes no input", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:Input");
  expect(app.enabled("id:disabled")).toBe(false);
});
