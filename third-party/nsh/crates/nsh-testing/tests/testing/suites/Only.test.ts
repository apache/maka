import { describe, test } from "nsh/test";

test("is skipped while another is only", () => {
  throw new Error("ran");
});

test.only("runs", () => {});

describe.only("focused block", () => {
  test("runs too", () => {});
});

describe("other block", () => {
  test("is skipped", () => {
    throw new Error("ran");
  });
});
