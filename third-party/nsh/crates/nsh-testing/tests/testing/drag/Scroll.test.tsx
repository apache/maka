import {expect, open, test} from "nsh/test";

test("native drag: the long-press deadline can precede a scrolls delayed press", async () => {
  const app = await open("./Scroll.tsx", {platform: "ios"});
  await app.dragAndHold("id:source", {x: 0, y: 0}, {hold: 80});
  try { expect(app.texts()).toContain("longs=1"); }
  finally { await app.drop(); }
});
