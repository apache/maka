import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const log: string[] = [];

beforeEach(() => {
  log.push("before file");
});
afterEach(() => {
  log.push("after file");
});

describe("cart", () => {
  let app: App;
  beforeAll(async () => {
    log.push("open");
    app = await open("../todo/App.tsx");
  });
  afterAll(() => {
    log.push("close");
  });
  beforeEach(() => {
    log.push("before cart");
  });
  afterEach(() => {
    log.push("after cart");
  });

  test("adds", async () => {
    await app.type("id:new-todo", "Milk\n");
    await app.waitFor("Milk");
  });

  describe("again", () => {
    test("keeps what the first test added", () => {
      // The app beforeAll opened is still open.
      expect(app.texts()).toContain("Milk");
    });
  });
});

test("ran the hooks in order", () => {
  expect(log).toEqual([
    "open",
    "before file",
    "before cart",
    "after cart",
    "after file",
    "before file",
    "before cart",
    "after cart",
    "after file",
    "close",
    "before file",
  ]);
});

test.skip("is skipped", () => {
  throw new Error("ran");
});

test.todo("is still to write");

describe.skip("skipped block", () => {
  test("is skipped too", () => {
    throw new Error("ran");
  });
});

test("fails after its timeout", () => new Promise((resolve) => setTimeout(resolve, 2000)), 100);

describe("a failing beforeEach", () => {
  beforeEach(() => {
    throw new Error("no fixture");
  });
  afterEach(() => {
    log.push("after a failing beforeEach");
  });
  test("fails", () => {});
  test("still ran its afterEach", () => {});
});

describe("a failing beforeAll", () => {
  beforeAll(() => {
    throw new Error("no server");
  });
  test("fails", () => {});
  describe("inner", () => {
    test("fails too", () => {});
  });
});

describe("a failing afterAll", () => {
  afterAll(() => {
    throw new Error("left a mess");
  });
  test("passes", () => {});
});

test("cannot declare tests", () => {
  expect(() => test("nested", () => {})).toThrow("declares as the file loads");
  expect(log.filter((l) => l === "after a failing beforeEach")).toHaveLength(2);
});
