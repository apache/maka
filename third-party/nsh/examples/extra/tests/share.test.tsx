// The system's share sheet with `nsh-extra`'s `Share`: the module's fake
// (`"nsh-extra/share"`) shows no sheet until the test answers
// (`app.fake(SHARE, "answer", [{ action, target }])`), then answers every
// share so and lists what the app shared (`app.fake(SHARE, "shares")`).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const SHARE = "nsh-extra/share";

let app: App;

beforeEach(async () => {
  app = await open("../App.tsx");
});

test("without a share sheet the share is unavailable, never shared", async () => {
  await app.waitFor("text:share sheet: no");
  await app.press("label:Share link");
  await app.waitFor("text:shared: ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
  expect(await app.fake(SHARE, "shares")).toEqual([]);
});

test("the user shares the link to a target, or closes the sheet", async () => {
  await app.fake(SHARE, "answer", [{ action: "shared", target: "com.apple.UIKit.activity.Mail" }]);
  await app.press("label:Share link");
  await app.waitFor("text:shared: shared com.apple.UIKit.activity.Mail");
  await app.fake(SHARE, "answer", [{ action: "dismissed" }]);
  await app.press("label:Share text");
  await app.waitFor("text:shared: dismissed");
  expect(await app.fake(SHARE, "shares")).toEqual([
    {
      title: "Weekend in Kyoto",
      text: "Our plan for the weekend: temples in the morning, the market at noon.",
      url: "https://example.com/trips/kyoto",
      files: [],
      // Each button anchors its share at itself.
      anchored: true,
    },
    {
      title: null,
      text: "Our plan for the weekend: temples in the morning, the market at noon.",
      url: null,
      files: [],
      anchored: true,
    },
  ]);
});

test("a share left open is dismissed by the next", async () => {
  await app.fake(SHARE, "hold");
  await app.press("label:Share link");
  await app.press("label:Share text");
  await app.waitFor("text:shared: dismissed");
  expect(await app.fake(SHARE, "shares")).toHaveLength(2);
});
