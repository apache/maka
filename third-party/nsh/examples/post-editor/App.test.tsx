// The post editor, headless: the suggestions of the three triggers, the
// trend menu of a stock tag, a tag deleted whole, and the HTML going out
// and coming back.
import { expect, open, test } from "nsh/test";

const SAMPLE =
  '<p>看多 <span type="security-tag" counter_id="ST/US/NVDA" name="NVIDIA" trend="1"></span> ' +
  '<span type="mention" member_id="1001" name="Alice">@Alice</span> 的下一个季度</p>';
const PARAGRAPH = "看多 $NVIDIA @Alice 的下一个季度";
const EDITOR = "id:post-editor";

/** The HTML the page shows as `getHTML()`. */
function html(app: Awaited<ReturnType<typeof open>>): string {
  return app.texts().find((t) => t.startsWith("<p>")) ?? "";
}

/** Opens the page with the caret at the end of the post. */
async function start() {
  const app = await open("./App.tsx");
  await app.press(PARAGRAPH);
  await app.keyboard.press("mod+End");
  return app;
}

/** Types a trigger and a query and picks the first candidate with Enter. */
async function pick(app: Awaited<ReturnType<typeof open>>, typed: string) {
  await app.type(EDITOR, typed);
  await app.waitFor("id:suggestions");
  await app.keyboard.press("enter");
  await app.waitFor("id:suggestions", { state: "gone" });
}

test("the post it starts from goes out as the HTML it came in as", async () => {
  const app = await open("./App.tsx");
  expect(html(app)).toBe(SAMPLE);
  // The stock tag's span is empty, as the web writes it: only "@Alice" counts.
  expect(app.shows("text:hashtags: []")).toBe(true);
});

test("$ finds a stock, and Enter makes it a tag in the web's format", async () => {
  const app = await start();
  await app.type(EDITOR, " $te");
  await app.waitFor("id:suggestions");
  expect(app.shows("TSLA.US")).toBe(true);
  expect(app.shows("NVDA.US")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor("id:suggestions", { state: "gone" });
  expect(html(app)).toContain('<span type="security-tag" counter_id="ST/US/TSLA" name="Tesla"></span>');
});

test("@ finds a member, picked by the arrow keys", async () => {
  const app = await start();
  await app.type(EDITOR, " @");
  await app.waitFor("id:suggestions");
  // Alice, Bob: the second one.
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("id:suggestions", { state: "gone" });
  expect(html(app)).toContain('<span type="mention" member_id="1002" name="Bob">@Bob</span>');
});

test("# picks a topic into the hashtags, not into the text", async () => {
  const app = await start();
  const before = html(app);
  await pick(app, " #降");
  expect(html(app)).toBe(before.replace("</p>", " </p>"));
  expect(app.shows("text:hashtags: [\"降息\"]")).toBe(true);
  expect(app.shows("#降息#  ×")).toBe(true);
  // Twice is once; a chip's press takes it away.
  await pick(app, "#降");
  expect(app.shows("text:hashtags: [\"降息\"]")).toBe(true);
  await app.press("label:移除话题 降息");
  expect(app.shows("text:hashtags: []")).toBe(true);
});

test("a press on a suggestion picks it", async () => {
  const app = await start();
  await app.type(EDITOR, " $te");
  await app.waitFor("id:suggestions");
  await app.press("Tesla");
  await app.waitFor("id:suggestions", { state: "gone" });
  expect(html(app)).toContain('counter_id="ST/US/TSLA"');
});

test("Escape closes the list and typing on does not open it again", async () => {
  const app = await start();
  await app.type(EDITOR, " $");
  await app.waitFor("id:suggestions");
  await app.keyboard.press("escape");
  await app.waitFor("id:suggestions", { state: "gone" });
  await app.type(EDITOR, "te");
  expect(app.count("id:suggestions")).toBe(0);
  expect(html(app)).not.toContain("TSLA");
});

test("a press on a stock tag opens its menu: the trend is 0, 1 or 2, changed and undone", async () => {
  const app = await open("./App.tsx");
  await app.clear("label:HTML");
  await app.type("label:HTML", '<p>看多 <span type="security-tag" counter_id="HK/700" name="腾讯"></span></p>');
  await app.press("label:载入 HTML");
  await app.waitFor("看多 $腾讯");
  expect(app.count("id:trend-menu")).toBe(0);
  // The line's end is beside the tag: a press there lands on it.
  await app.press("看多 $腾讯");
  await app.waitFor("id:trend-menu");
  await app.press("label:看空");
  expect(html(app)).toContain('counter_id="HK/700" name="腾讯" trend="2"></span>');
  await app.press("label:看多");
  expect(html(app)).toContain('name="腾讯" trend="1"></span>');
  await app.keyboard.press("mod+z");
  expect(html(app)).toContain('name="腾讯" trend="2"></span>');
  await app.press("label:中立");
  expect(html(app)).toContain('name="腾讯" trend="0"></span>');
});

test("Backspace deletes a tag whole", async () => {
  const app = await start();
  await pick(app, " $te");
  for (let i = 0; i < 3 && html(app).includes("TSLA"); i++) {
    await app.keyboard.press("backspace");
  }
  expect(html(app)).not.toContain("TSLA");
  expect(html(app)).toContain("的下一个季度");
});

test("HTML read back becomes the document, a missing name filled in", async () => {
  const app = await open("./App.tsx");
  const input =
    '<p><span type="security-tag" counter_id="ST/HK/700" name="腾讯控股" trend="2"></span> 与 ' +
    '<span type="mention" member_id="1003" name="老王">@老王</span></p>';
  await app.clear("label:HTML");
  await app.type("label:HTML", input);
  await app.press("label:载入 HTML");
  await app.waitFor("$腾讯控股 与 @老王");
  expect(html(app)).toBe(input);
  await app.clear("label:HTML");
  await app.type("label:HTML", '<p><span type="security-tag" counter_id="ST/US/TSLA"></span></p>');
  await app.press("label:载入 HTML");
  await app.waitFor("$TSLA");
  expect(html(app)).toBe('<p><span type="security-tag" counter_id="ST/US/TSLA" name="TSLA"></span></p>');
});

test("the HTML the editor wrote reads back to the same HTML", async () => {
  const app = await start();
  await pick(app, " $te");
  await pick(app, "@bo");
  // A trailing space is the one thing reading drops (white space collapses
  // as in a browser): the output settles after one round.
  const written = html(app);
  await app.press("label:读回上面的输出");
  const settled = html(app);
  expect(settled).toBe(written.replace(" </p>", "</p>"));
  await app.press("label:读回上面的输出");
  expect(html(app)).toBe(settled);
});
