// The AI Chat demo on a manual clock: the empty chat offers its
// scenarios, a message sent offline waits for the connection, a reply
// that thinks first folds its reasoning when done, and a failed reply
// shows its error and retries.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:AI Chat");
});

/** Runs the clock a tenth of a second at a time until `done` holds. */
async function until(done: () => boolean, ms = 10_000) {
  for (let t = 0; !done(); t += 100) {
    if (t >= ms) throw new Error(`not done in ${ms} ms: ${JSON.stringify(app.texts())}`);
    await app.clock!.runFor(100);
  }
}

const has = (part: string) => app.texts().some((t) => t.includes(part));

test("offers its scenarios", () => {
  for (const text of [
    "How can I help?",
    "Explain list virtualization",
    "Think it through",
    "Search the web",
    "Describe a photo",
    "Tell me a short story",
    "Load a long conversation",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("a message sent offline waits for the connection", async () => {
  // The suggestion under the input (the "+" menu, hidden, lists it too).
  await app.press("text:Go offline >> nth=1");
  await until(() => app.shows("Waiting for a connection"));
  await until(() => has("Tuesday, November 3") && !app.shows("Waiting for a connection"));
  // Done streaming: the reply can no longer be stopped.
  await until(() => !app.shows("label:Stop generating"));
});

test("a reply that thinks first folds its reasoning, which opens again", async () => {
  await app.press("text:Think it through >> nth=0");
  await until(() => has("The quick answer is 0.10"));
  await until(
    () => has("The intuitive answer, 0.10, would make the total 1.20.") && !has("The quick answer is 0.10"),
  );
  const thought = app.texts().find((t) => t.startsWith("Thought for "));
  expect(thought).toBeTruthy();
  await app.press(thought!);
  await until(() => has("The quick answer is 0.10"));
});

test("a failed reply shows its error and retries in its place", async () => {
  await app.press("text:Fail a reply >> nth=1");
  await until(() => app.shows("Summarize this week's meeting notes."));
  await until(() => app.shows("Retry"));
  expect(app.texts()).toContain("The model is overloaded right now (error 529).");
  expect(has("The planning session agreed on")).toBe(true);
  await app.press("Retry");
  await until(() => has("Retro: fewer meetings next sprint."));
  expect(app.shows("Retry")).toBe(false);
  expect(has("Planning: the launch moves to November 3.")).toBe(true);
});
