// The System demo: the environment, the status bar's preview, system
// dialogs and their answers, a timer, display frames and a request.
import { expect, open, test } from "nsh/test";

const POSTS = "GET https://jsonplaceholder.typicode.com/posts?_limit=3";

test("shows the environment and previews the status bar", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:System");
  for (const text of [
    "Environment",
    "Live",
    "390 × 844 pt",
    "0 pt",
    "1.00×",
    "Safe area insets",
    "Bottom",
    "Light scheme",
    "Status bar",
    'foreground: "dark"',
    "Alerts and sheets",
    "None yet",
    "Frames and timers",
    "Network and logs",
    "Three posts from jsonplaceholder.typicode.com",
  ]) {
    expect(app.texts()).toContain(text);
  }
  await app.press("Light");
  await app.waitFor('text:foreground: "light"');
  await app.press("label:Hide the status bar");
  // The preview's dialog shows the setting while it is open.
  await app.press("Preview");
  await app.waitFor('statusBar: { foreground: "light", hidden: true }');
  await app.press("Close");
  await app.waitFor('statusBar: { foreground: "light", hidden: true }', { state: "gone" });
});

test("the environment follows the window and the appearance", async () => {
  const app = await open(".", { clock: {}, safeArea: { top: 47, bottom: 34 } });
  await app.press("label:System");
  const texts = app.texts();
  expect(texts[texts.indexOf("Top") + 1]).toBe("47");
  expect(texts[texts.indexOf("Bottom") + 1]).toBe("34");
  await app.setViewport(844, 390);
  await app.waitFor("844 × 390 pt");
  await app.setColorScheme("dark");
  await app.waitFor("Dark scheme");
});

test("shows what dialogs answer", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:System");
  app.onDialog((dialog) => (dialog.title === "Delete the photo?" ? "Delete" : "Save"));
  await app.press("Confirm");
  const confirm = app.dialogs()[0];
  expect(confirm.title).toBe("Delete the photo?");
  expect(confirm.buttons).toHaveLength(2);
  expect(confirm.cancelable).toBe(true);
  expect(confirm.sheet).toBe(false);
  await app.waitFor("Delete");

  await app.press("Action sheet");
  const sheet = app.dialogs()[1];
  expect(sheet.sheet).toBe(true);
  expect(sheet.title).toBe("Share the photo");
  expect(sheet.buttons[2]).toBe("Save");
  await app.waitFor("Save");

  // Dismissing the sheet is its cancel action.
  app.onDialog(() => null);
  await app.press("Action sheet");
  await app.waitFor("Cancel");
});

test("a timer counts seconds", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:System");
  expect(app.texts()).toContain("0 every 1 s");
  await app.clock!.runFor(1100);
  await app.waitFor("text:/^[1-9]\\d* every 1 s$/");
});

test("counts display frames while asked", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:System");
  expect(app.texts()).toContain("– fps stopped");
  await app.press("Count frames");
  expect(app.texts()).toContain("Stop counting frames");
  await app.clock!.runFor(1200);
  await app.waitFor("text:/^[1-9]\\d* fps live$/");
  await app.press("Stop counting frames");
  await app.waitFor("– fps stopped");
});

test("loads the posts and shows how the request went", async () => {
  const app = await open(".", {
    clock: {},
    network: {
      [POSTS]: {
        body: [
          { id: 1, title: "First post" },
          { id: 2, title: "Second post" },
          { id: 3, title: "Third post" },
        ],
      },
    },
  });
  await app.press("label:System");
  await app.press("fetch()");
  await app.waitFor("Third post");
  for (const text of ["#1", "First post", "#2", "Second post"]) {
    expect(app.texts()).toContain(text);
  }
  await app.waitFor("text:/^HTTP 200 · \\d+ ms$/");
  expect(app.requests().map((r) => r.url)).toEqual(["https://jsonplaceholder.typicode.com/posts?_limit=3"]);
});

test("a failed request says why, and the button loads again", async () => {
  const app = await open(".", { clock: {}, network: { [POSTS]: { error: "offline" } } });
  await app.press("label:System");
  await app.press("fetch()");
  await app.waitFor("text:/offline/");
  // Done: the button is back, and pressing it loads again.
  await app.press("fetch()");
  await app.waitFor("text:/offline/");
  expect(app.requests()).toHaveLength(2);
});
