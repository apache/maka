// A scroll view the app lifts above the software keyboard keeps no inset
// for it: the keyboard's room was measured before the app's answer moved
// the panel up, so the panel kept an inset as tall as the keyboard and
// scrolled its rows up for nothing, and its input counted as under the
// keyboard. A simulator with a hardware keyboard attached shows no software
// keyboard: then nothing moves either way.
import { expect, open, test } from "nsh/test";

test("an input in a panel lifted above the keyboard stays where it is", async () => {
  const app = await open("./LiftedPanel.tsx");
  await app.waitFor("text:row:One");
  await app.paste("id:other", { text: "Singapore" });
  await app.waitFor("text:value:Singapore");
  await app.wait(800);
  expect(app.shows("text:offset:0")).toBe(true);
  // Still clear of the keyboard for the test agent too: no inset left for
  // the keyboard covers the input.
  await app.paste("id:other", { text: "!" });
  await app.waitFor("text:value:Singapore!");
});
