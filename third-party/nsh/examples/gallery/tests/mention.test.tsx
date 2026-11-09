// A hardware keyboard's arrows and return move through @-mention
// candidates while the message input keeps the focus (`nsh/keymap` with
// `when: "always"`): on phones and tablets as on the desktops.
import { open, test } from "nsh/test";

test("the arrows pick a candidate and return inserts it", async () => {
  const app = await open("./fixtures/mention.tsx");
  await app.type("id:msg", "hi @");
  await app.waitFor("text:candidate: Alice");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.waitFor("text:candidate: Carol");
  await app.keyboard.press("enter");
  await app.waitFor("text: hi @Carol ");
});
