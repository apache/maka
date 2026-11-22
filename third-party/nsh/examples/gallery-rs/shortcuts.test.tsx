// Run with --target web as well: Rust shortcut IDs cross the WebAssembly
// boundary above i32::MAX, unlike the gallery's JS keymap bindings.
import { open, test } from "nsh/test";

test("Rust shortcuts count, switch the light and reset", async () => {
  const app = await open(".", { platform: "macos" });
  await app.press("label:System");
  await app.waitFor("Counted 0");
  await app.keyboard.press("mod+k");
  await app.waitFor("Counted 1");
  await app.keyboard.press("mod+shift+l");
  await app.waitFor("Light on");
  await app.keyboard.press("mod+backspace");
  await app.waitFor("Counted 0");
});
