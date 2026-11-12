// The TSX app without its crate: `open`'s `modules` stand in for the
// crate's exports. Stand-ins are the headless runner's, so this file runs
// without `--target`.
import { expect, open, test } from "nsh/test";

test("open's modules stand in for the crate's module", async () => {
  const calls: unknown[][] = [];
  const app = await open("./App.tsx", {
    modules: {
      "rust-exports/native": {
        // A value: the plain function returns it at once.
        "Ledger.format": "$9.99",
        // A function: each call is a promise of what it returns.
        "Ledger.fetchRate": async (...args) => {
          calls.push(args);
          return 0.25;
        },
      },
    },
  });
  expect(app.shows("Formatted at once: $9.99")).toBe(true);
  await app.press("Fetch rate");
  await app.waitFor("Rate: 25%");
  expect(calls).toEqual([[]]);
});
