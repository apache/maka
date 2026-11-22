// The System page's share sheet: `Share.show` hands the content to the
// system, which the test answers (`app.onShare`); without a share sheet the
// card says so, and never that it shared.
import { expect, open, test } from "nsh/test";

test("a platform without a share sheet is reported, not shared", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[System]");
  await app.waitFor("Not on this platform");
  await app.press("label:A link");
  await app.waitFor("No share sheet here");
  expect(app.shares()).toEqual([]);
});

test("a link is shared with its title, text and URL", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.onShare({ action: "shared", target: "com.apple.UIKit.activity.Mail" });
  await app.press("role:button[System]");
  await app.waitFor("Available");
  await app.press("label:A link");
  await app.waitFor("Shared to Mail");
  expect(app.shares()).toEqual([
    {
      title: "Weekend in Kyoto",
      text: "Our plan for the weekend: temples in the morning, the market at noon.",
      url: "https://example.com/trips/kyoto",
      files: [],
    },
  ]);
});

test("closing the sheet shows it was dismissed", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.onShare({ action: "dismissed" });
  await app.press("role:button[System]");
  await app.press("label:Only text");
  await app.waitFor("Dismissed");
  expect(app.shares().map((s) => s.text)).toEqual([
    "Our plan for the weekend: temples in the morning, the market at noon.",
  ]);
});
