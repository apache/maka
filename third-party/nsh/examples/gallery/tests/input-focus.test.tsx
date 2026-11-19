// #2226: reuse the gallery fixture for focus/editing checks on every
// backend. Native glyph origins and scrolling are asserted separately in
// nsh-platform-macos/tests/native/input_focus.rs using this same fixture.
import { expect, open, test } from "nsh/test";

test("switching between long and short inputs preserves their values and insertion point", async () => {
  const app = await open("./fixtures/input-focus.tsx", { width: 600, height: 500 });
  const original = app.value("id:long");
  for (let i = 0; i < 3; i++) {
    await app.press("label:Focus short");
    await app.press("label:Focus long");
    expect(app.value("id:long")).toBe(original);
    expect(app.value("id:short")).toBe("ABC");
  }
  // Programmatic focus places the insertion point at the end. Typing
  // must append without replacing the value.
  await app.keyboard.press("x");
  expect(app.value("id:long")).toBe(`${original}x`);
  expect(app.value("id:reference")).toBe(original);
});
