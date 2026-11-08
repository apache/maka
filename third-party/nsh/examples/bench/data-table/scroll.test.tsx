// Opens the DataTable scroll workload in a desktop window and leaves it
// for an outside driver (a scroll bar drag, the wheel) while `--fps` logs.
import { open, test } from "nsh/test";

test("the DataTable scroll workload", async () => {
  const app = await open("./App.tsx", { platform: "linux", width: 1280, height: 800 });
  await app.waitFor("#0");
  await app.wait(20_000);
});
