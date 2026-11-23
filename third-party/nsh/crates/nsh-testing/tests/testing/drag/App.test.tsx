import { type DragOptions, expect, open, test } from "nsh/test";

test("native drag: a held drag waits for the long press and only drop lifts the same finger", async () => {
  const app = await open("./App.tsx");
  const options: DragOptions = { hold: 600 };
  await app.dragAndHold("id:source", { x: 120, y: 0 }, options);
  try {
    expect(app.texts()).toContain("phase=moving");
    expect(app.texts()).toContain("longs=1");
    expect(app.texts()).toContain("ends=0");
  } finally {
    await app.drop();
  }
  expect(app.texts()).toContain("phase=dropped");
  expect(app.texts()).toContain("ends=1");
  expect(app.texts()).toContain("taps=0");
  await expect(() => app.drop()).rejects.toThrow(/no (?:finger|pointer) is down/);
});

test("native drag: drag uses the requested initial hold then lifts; the default stays a short drag", async () => {
  const app = await open("./App.tsx");
  await app.drag("id:source", { x: 120, y: 0 });
  expect(app.texts()).toContain("longs=0");
  expect(app.texts()).toContain("ends=1");
  await app.drag("id:source", { x: 120, y: 0 }, { hold: 600 });
  expect(app.texts()).toContain("phase=dropped");
  expect(app.texts()).toContain("longs=1");
  expect(app.texts()).toContain("ends=2");
  expect(app.texts()).toContain("taps=0");
});

test("native drag: invalid drag holds reject before input; a zero hold is allowed", async () => {
  const app = await open("./App.tsx");
  for (const hold of [-1, NaN, Infinity, Number.MAX_VALUE]) {
    await expect(() => app.drag("id:source", { x: 120 }, { hold })).rejects.toThrow("drag hold");
    await expect(() => app.dragAndHold("id:source", { x: 120 }, { hold })).rejects.toThrow("drag hold");
  }
  expect(app.texts()).toContain("phase=idle");
  await app.drag("id:source", { x: 120 }, { hold: 0 });
  expect(app.texts()).toContain("longs=0");
  expect(app.texts()).toContain("ends=1");
});


test("native drag: a stationary held finger keeps its long press timer alive during later waits", async () => {
  const app = await open("./App.tsx");
  await app.dragAndHold("id:source", { x: 0, y: 0 }, { hold: 0 });
  try {
    expect(app.texts()).toContain("longs=0");
    await app.wait(650);
    expect(app.texts()).toContain("longs=1");
    expect(app.texts()).toContain("ends=0");
  } finally {
    await app.drop();
  }
  expect(app.texts()).toContain("ends=1");
  expect(app.texts()).toContain("taps=0");
});
