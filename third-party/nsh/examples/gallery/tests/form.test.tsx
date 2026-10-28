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
