import { open, test } from "nsh/test";

test("the app runs under the capabilities its nsh.json declares", async () => {
  // Both answered by the test; only the declared host is reached.
  const app = await open("./App.tsx", {
    network: {
      "GET https://api.test/declared": { body: { ok: true } },
      "GET https://other.test/undeclared": { body: { ok: true } },
    },
  });
  await app.waitFor("text:declared: ok 200");
  await app.waitFor("text:other: refused ERR_ACCESS_DENIED");
});
