import { expect, open, test } from "nsh/test";

const START = new Date("2026-01-01T09:00:00.000Z");

test("time stands still until the test moves it", async () => {
  const app = await open("./App.tsx", { clock: { time: START } });
  expect(app.shows("Today: 2026-01-01T09:00:00.000Z")).toBe(true);
  await app.clock!.runFor(2500);
  expect(app.shows("Ticks: 2")).toBe(true);
  expect(app.shows("Saved: not yet")).toBe(true);
  await app.clock!.runFor(7500);
  expect(app.shows("Saved: at 2026-01-01T09:00:10.000Z")).toBe(true);
  expect(app.shows("Ticks: 10")).toBe(true);
});

test("wait moves a manual clock", async () => {
  const app = await open("./App.tsx", { clock: {} });
  await app.wait(3000);
  expect(app.shows("Ticks: 3")).toBe(true);
});

test("fastForward runs each due timer once", async () => {
  const app = await open("./App.tsx", { clock: { time: START } });
  await app.clock!.fastForward(60_000);
  expect(app.shows("Saved: at 2026-01-01T09:01:00.000Z")).toBe(true);
  expect(app.shows("Ticks: 1")).toBe(true);
});

test("a step finishes native animations without waiting for them", async () => {
  const app = await open("./App.tsx", { clock: { time: START } });
  const started = Date.now();
  await app.press("Move");
  expect(app.shows("Moved: done")).toBe(true);
  // A 1.5 s animation, in much less real time.
  expect(Date.now() - started).toBeLessThan(1000);
  // Its frames moved the clock: the timer due meanwhile ran.
  expect(app.shows("Ticks: 1")).toBe(true);
});

test("a delayed response comes when the clock passes it", async () => {
  const app = await open("./App.tsx", {
    clock: {},
    network: { "https://api.test/slow": { body: "at last", delay: 5000 } },
  });
  await app.press("Load");
  expect(app.shows("Loaded: nothing")).toBe(true);
  await app.clock!.runFor(4900);
  expect(app.shows("Loaded: nothing")).toBe(true);
  await app.clock!.runFor(100);
  expect(app.shows("Loaded: at last")).toBe(true);
});

test("setSystemTime moves the wall time only", async () => {
  const app = await open("./App.tsx", { clock: { time: START } });
  app.clock!.setSystemTime(new Date("2030-06-01T12:00:00.000Z"));
  await app.press("Now");
  expect(app.shows("Today: 2030-06-01T12:00:00.000Z")).toBe(true);
  expect(app.shows("Ticks: 0")).toBe(true);
});

test("an app on the system's clock has no clock to move", async () => {
  const app = await open("./App.tsx");
  expect(app.clock).toBe(null);
});

test("waitFor moves a manual clock until what it waits for shows", async () => {
  const app = await open("./App.tsx", { clock: { time: START } });
  const started = Date.now();
  await app.waitFor("Saved: at 2026-01-01T09:00:10.000Z", { timeout: 15_000 });
  // Ten seconds of the app's time, in much less real time, stopping there.
  expect(Date.now() - started).toBeLessThan(5000);
  expect(app.shows("Ticks: 10")).toBe(true);
});

test("a wait moves a manual clock by its timeout at most", async () => {
  const app = await open("./App.tsx", { clock: {} });
  await expect(() => app.waitFor("Ticks: 100", { timeout: 2000 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(app.shows("Ticks: 2")).toBe(true);
});

test("waitUntil moves a manual clock between its looks", async () => {
  const app = await open("./App.tsx", { clock: {} });
  await app.waitUntil(() => app.shows("Ticks: 3"));
  await expect(() => app.waitUntil(() => app.shows("Ticks: 100"), { timeout: 1000 })).rejects.toMatchObject({
    code: "ETIMEDOUT",
  });
  expect(app.shows("Ticks: 4")).toBe(true);
});
