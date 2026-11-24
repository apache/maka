import {expect, open, test} from "nsh/test";

test("a stationary held finger follows later manual clock frames", async () => {
  const app = await open("./App.tsx", {clock: {}});
  const clock = app.clock;
  if (!clock) throw new Error("the manual test clock was not created");
  await app.dragAndHold("id:source", {x: 0, y: 0}, {hold: 0});
  try {
    expect(app.texts()).toContain("longs=0");
    await clock.runFor(650);
    expect(app.texts()).toContain("longs=1");
  } finally { await app.drop(); }
  expect(app.texts()).toContain("ends=1");
});


test("a long-press deadline between initial hold and first move is delivered before Up", async () => {
  const app = await open("./Scroll.tsx", {clock: {}, platform: "ios"});
  await app.drag("id:source", {x: 1, y: 0}, {hold: 49});
  expect(app.texts()).toContain("longs=1");
});
