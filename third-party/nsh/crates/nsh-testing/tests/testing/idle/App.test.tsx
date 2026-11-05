import { expect, open, test } from "nsh/test";

/** How many steps the timed tests take. */
const STEPS = 30;

test("on a manual clock, steps return once the app is idle", async () => {
  const app = await open("./App.tsx", { clock: {} });
  // The first render came before `open` resolved.
  expect(app.shows("Count: 0")).toBe(true);
  const started = Date.now();
  for (let i = 1; i <= STEPS; i++) {
    await app.press("Add");
    expect(app.shows(`Count: ${i}`)).toBe(true);
  }
  // Less than the 100 ms of quiet each step waits for on the system's clock.
  expect(Date.now() - started).toBeLessThan(STEPS * 100);
});

test("on a manual clock, what a step makes due now comes before it returns", async () => {
  const app = await open("./App.tsx", {
    clock: {},
    network: { "https://api.test/now": { body: "here" } },
  });
  await app.type("id:field", "abc");
  expect(app.shows("Typed: abc")).toBe(true);
  await app.press("Later");
  expect(app.shows("Later: done")).toBe(true);
  await app.press("Load");
  expect(app.shows("Loaded: here")).toBe(true);
});

test("on a manual clock, a timer fires when the clock reaches it", async () => {
  const app = await open("./App.tsx", { clock: {} });
  await app.clock.runFor(999);
  expect(app.shows("Timer: waiting")).toBe(true);
  await app.clock.runFor(1);
  expect(app.shows("Timer: fired")).toBe(true);
});

test("on the system's clock, a step waits for the app to be quiet", async () => {
  const app = await open("./App.tsx");
  const started = Date.now();
  await app.press("Add");
  expect(app.shows("Count: 1")).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
});
