import { expect, open, test } from "nsh/test";

// The newest modal takes the keys: Escape reaches the dialog, not the field
// under it that still had the focus (#2291), on every platform.
for (const platform of ["ios", "android", "macos", "windows", "linux", "web"] as const) {
  for (const field of ["editor", "input"]) {
    test(`escape closes a dialog opened while the ${field} has the focus on ${platform}`, async () => {
      const app = await open("./App.tsx", { platform });
      await app.type(`id:${field}`, "hello");
      await app.press("id:open");
      await app.waitFor("In dialog");
      await app.keyboard.press("escape");
      await app.waitFor("Cancelled: 1");
      expect(app.shows("In dialog")).toBe(false);
    });
  }
}
