// The WebView, Video and Photos demos: the buttons driving the video and
// the web views, and a long list that loads more at its end.
import { expect, open, test } from "nsh/test";

test("the video's buttons play it, and the system's controls replace them", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Video");
  for (const text of [
    "Video",
    "AVPlayer / MediaPlayer",
    "Paused",
    "Restart",
    "0:00",
    "Own controls",
    "System controls",
  ]) {
    expect(app.texts()).toContain(text);
  }
  await app.press("label:Play");
  await app.waitFor("Playing");
  expect(app.shows("label:Pause")).toBe(true);
  await app.press("System controls");
  await app.waitFor("Restart", { state: "gone" });
  await app.press("Own controls");
  await app.waitFor("Restart");
});

test("a message posted to the page is shown as sent", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:WebView");
  for (const text of [
    "Web view",
    "Inline HTML, with messages both ways",
    "From the page",
    "To the page",
    "A web site",
    "Navigation state, back and forward",
    "Loaded",
    "Post to the page",
    "…",
    "Reload",
  ]) {
    expect(app.texts()).toContain(text);
  }
  await app.press("Post to the page");
  await app.waitFor("text:/^hi #/");
});

test("the photo stream loads more at its end", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Photos");
  for (const text of [
    "1,000 photos",
    "Ridge 0001",
    "Linus",
    "· 8.0k views",
    "#1",
    "Old town 0002",
    "Grace",
    "Refreshes",
    "Pull to refresh. Scrolling to the end loads 200 more.",
  ]) {
    expect(app.texts()).toContain(text);
  }
  await app.scroll("Ridge 0001", 1_000_000);
  await app.waitFor("1,200 photos");
  const texts = app.texts();
  expect(texts[texts.indexOf("Pages") + 1]).toBe("6");
});
