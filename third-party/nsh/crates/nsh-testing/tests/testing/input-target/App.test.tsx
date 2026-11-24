import { expect, open, test } from "nsh/test";

test("Editor value is its complete document", async () => {
  const app = await open("./App.tsx");
  expect(app.value("ed")).toBe("Hallo\nworld");
  await app.type("ed", "A");
  expect(app.value("ed")).toBe("AHallo\nworld");
  await app.press("Update document");
  expect(app.value("ed")).toBe("external\nupdate");
});

test("typing a shared prefix after clearing the Editor keeps the whole input", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.type("ed", "x");
  for (const text of ["ab ", "ab cd", "ab cd🙂"]) {
    await app.keyboard.press("mod+a");
    await app.keyboard.press("backspace");
    expect(app.value("ed")).toBe("");
    await app.type("ed", text);
    expect(app.value("ed")).toBe(text);
  }
  await app.keyboard.press("end");
  await app.keyboard.press("shift+left");
  await app.keyboard.press("backspace");
  expect(app.value("ed")).toBe("ab cd");
});

test("covered input steps never edit the input above", async () => {
  const app = await open("./App.tsx");
  // Headless can address the input directly; native targets must reject
  // a pointer that would land in another input.
  for (const step of [() => app.clear("under"), () => app.type("under", "X")]) {
    try { await step(); }
    catch (error) { expect(error).toMatchObject({ code: "ERR_NSH_TEST_COVERED" }); }
    expect(app.value("over")).toBe("O");
  }
});
