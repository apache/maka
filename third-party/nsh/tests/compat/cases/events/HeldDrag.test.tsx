import { type DragOptions, expect, open, test } from "nsh/test";

test("drag timing extends the existing calls and keeps a held touch until drop", async () => {
  const app = await open("./App.tsx", { platform: "ios" });
  await app.press("id:case-events-held-drag");
  await app.drag("id:source", { x: 120 });
  expect(app.texts()).toContain("longs=0");
  expect(app.texts()).toContain("ends=1");
  const options: DragOptions = { hold: 600 };
  await app.drag("id:source", { x: 120 }, options);
  expect(app.texts()).toContain("longs=1");
  expect(app.texts()).toContain("ends=2");
  await app.dragAndHold("id:source", { x: 120 }, options);
  try {
    expect(app.texts()).toContain("phase=moving");
    expect(app.texts()).toContain("longs=2");
    expect(app.texts()).toContain("ends=2");
  } finally {
    await app.drop();
  }
  expect(app.texts()).toContain("phase=dropped");
  expect(app.texts()).toContain("ends=3");
  expect(app.texts()).toContain("taps=0");
});
