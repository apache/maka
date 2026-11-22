import { expect, test } from "nsh/test";
import hello from "../notes/hello.txt?url";
import beside from "./beside.txt?url";

// The test file's own imports are named from its app's directory, wherever
// the run writes the entry it makes for it, and read from there.
test("a test file reads the files it imports by their names in its app", async () => {
  expect(hello).toBe("asset:/notes/hello.txt");
  expect(beside).toBe("asset:/tests/beside.txt");
  expect((await (await fetch(hello)).text()).trim()).toBe("hello from the app");
  expect((await (await fetch(beside)).text()).trim()).toBe("beside the entry");
});
