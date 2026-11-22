import { test } from "nsh/test";

test("never runs", () => {});
throw new Error("the file is broken");
