// A press that raises the panel it lands in (#3244): AppKit drops the
// focus of a view taken out of its superview, so restacking must not
// re-add the view holding the focus.
import { open, test } from "nsh/test";

test("an input keeps the focus when the press that focused it raises its panel", async () => {
  const app = await open("./Restack.tsx", { width: 480, height: 240 });
  await app.type("id:input-b", "X");
  await app.waitFor("a= b=X top=b");
  await app.type("id:input-a", "Y");
  await app.waitFor("a=Y b=X top=a");
  // Typing goes on in the raised panel's input without another press.
  await app.keyboard.press("z");
  await app.waitFor("a=Yz b=X top=a");
});
