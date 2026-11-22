import { open, test } from "nsh/test";

test("an entry below its app reads its assets by their names in the app", async () => {
  const app = await open("./SubApp.tsx");
  await app.waitFor("Above: asset:/notes/hello.txt 200 hello from the app");
  await app.waitFor("Beside: asset:/tests/beside.txt 200 beside the entry");
  await app.waitFor("Literal: asset:/notes/hello.txt 200 hello from the app");
});
