import { expect, open, test } from "nsh/test";

test("a module without createHost fails open", async () => {
  await expect(() => open("./App.tsx")).rejects.toThrow("createHost");
});
