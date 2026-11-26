import { expect, open, test } from "nsh/test";

// #3288: one sheet, the same code on iOS and Android, keeps its header on
// screen with the keyboard up and is lifted once when padded by the
// keyboard inset.
const FIXTURE = "./fixtures/sheet-keyboard-tall.tsx";

// Only a real phone (`--target ios` or `android`) shows a software keyboard.
// Headless and browser runs take `host.handlers`, which a real platform
// rejects (`ERR_NSH_TEST_UNSUPPORTED`); the fixture calls none.
async function phone() {
  try {
    await open(FIXTURE, { host: { handlers: { unused: null } } });
    return null;
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_NSH_TEST_UNSUPPORTED") throw err;
  }
  const app = await open(FIXTURE);
  if (!app.shows("Platform: ios") && !app.shows("Platform: android")) return null;
  return app;
}

for (const mode of ["tall", "padded"]) {
  test(`a ${mode} sheet stays on screen above the keyboard`, async () => {
    const app = await phone();
    if (!app) return;
    await app.press(`id:open-${mode}`);
    await app.waitFor("id:close");
    await app.type("id:title", "A title");
    await app.waitFor("text:keyboard: up");
    await app.host.send("test:measure");
    await app.waitFor("text:layout: ok");
    expect(app.shows("id:close")).toBe(true);
    await app.press("id:close");
    await app.waitFor("text:sheet: closed");
    // Opened again, it is laid out the same way.
    await app.press(`id:open-${mode}`);
    await app.waitFor("id:close");
    await app.type("id:title", "Again");
    await app.waitFor("text:keyboard: up");
    await app.host.send("test:measure");
    await app.waitFor("text:layout: ok");
  });
}
