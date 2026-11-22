// The app's exports, tested from TypeScript with `nsh test`: it runs this
// file in the headless runner it builds with the app's crate.
import { expect, open, test } from "nsh/test";

test("the module returns values at once and promises", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("Formatted at once: $1,234.50")).toBe(true);
  await app.press("Copy statement");
  await app.waitFor("Copied 32 characters");
  await app.press("Fetch rate");
  await app.waitFor("Rate: 5%");
});

test("the class keeps its state in Rust", async () => {
  const app = await open("./App.tsx");
  await app.press("Deposit $25");
  await app.waitFor("Deposited: $145.00");
  await app.waitFor("Heard: 145");
  await app.press("Move $30");
  await app.waitFor("Checking: $70.00");
  await app.press("Accrue");
  await app.waitFor("Accrued: $116.15");
  expect(app.texts()).toContain("Savings: $116.15");
});
