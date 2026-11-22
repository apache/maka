// The block editor demo: a `/` menu of blocks (Tiptap's Suggestion, run
// natively), a handle on the block under the pointer, and a toolbar over a
// selection, each a command on the session the editor shows.
import { expect, open, test } from "nsh/test";

const ITEM = "Publish the migration guide";
const REVIEW = "Review the pricing page copy";

/** The demo on a phone, or on a desktop (`desktop`), whose pointer shows the handles. */
async function openDemo(desktop = false) {
  const app = await open("../App.tsx", desktop ? { platform: "macos", width: 1200, height: 900 } : undefined);
  await app.press("role:button[Block editor]");
  await app.waitFor(ITEM);
  return app;
}

/** A new empty line below the last task, with the caret in it. */
async function newLine(app: Awaited<ReturnType<typeof openDemo>>) {
  await app.press(ITEM);
  await app.keyboard.press("end");
  await app.keyboard.press("enter");
}

test("/ opens the blocks and typing narrows them", async () => {
  const app = await openDemo();
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  expect(app.shows("text:Heading 1")).toBe(true);
  expect(app.count("role:option")).toBe(14);
  await app.type("label:Document", "list");
  // Three lists match: bulleted, numbered, to-do.
  await app.waitFor("role:option[Divider]", { state: "gone" });
  expect(app.count("role:option")).toBe(3);
  expect(app.shows("text:Numbered list")).toBe(true);
  expect(app.shows("text:To-do list")).toBe(true);
});

test("Enter picks the highlighted block and the arrows move it", async () => {
  const app = await openDemo();
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  // Text, Heading 1, Heading 2: the second down is Heading 2.
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.type("label:Document", "Next steps");
  await app.waitFor("text:Next steps");
  // Heading 2 is 24 points (`text-2xl`).
  expect(app.spanStyle("text:Next steps").fontSize).toBe(24);
});

test("a press on a block of the menu picks it, and Escape closes the menu", async () => {
  const app = await openDemo();
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  await app.keyboard.press("escape");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  // The slash stays as text.
  await app.keyboard.press("backspace");
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  await app.press("role:option[Quote]");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.type("label:Document", "A quote");
  await app.waitFor("text:A quote");
  expect(app.spanStyle("text:A quote").italic).toBe(true);
});

test("a selection shows the toolbar, whose buttons format it", async () => {
  const app = await openDemo();
  await app.press(REVIEW);
  await app.keyboard.press("home");
  await app.keyboard.press("shift+end");
  await app.waitFor("role:toolbar[Format]");
  await app.press("role:button[Bold]");
  expect(app.spanStyle(`text:${REVIEW}`).fontWeight).toBe(700);
  // The toolbar follows the state: bold is on while the selection is bold.
  await app.press("role:button[Bold]");
  expect(app.spanStyle(`text:${REVIEW}`).fontWeight).toBe(400);
  // A caret without a range has no toolbar.
  await app.keyboard.press("right");
  await app.waitFor("role:toolbar[Format]", { state: "gone" });
});

test("the handle follows the pointer, and its menu turns the block into another", async () => {
  const app = await openDemo(true);
  await app.hover(`text:${REVIEW}`);
  await app.waitFor("role:button[Drag to move, press for the menu]");
  await app.press("role:button[Drag to move, press for the menu]");
  await app.waitFor("role:menu[Block]");
  await app.press("role:menuitem[Heading 3]");
  await app.waitFor("role:menu[Block]", { state: "gone" });
  // Heading 3 is 20 points (`text-xl`).
  expect(app.spanStyle(`text:${REVIEW}`).fontSize).toBe(20);
});

test("the handle's menu duplicates and deletes the block", async () => {
  const app = await openDemo(true);
  const before = app.count(`text:${REVIEW}`);
  await app.hover(`text:${REVIEW}`);
  await app.press("role:button[Drag to move, press for the menu]");
  await app.press("role:menuitem[Duplicate]");
  await app.waitFor(`text:${REVIEW} >> nth=1`);
  expect(app.count(`text:${REVIEW}`)).toBe(before + 1);
  await app.hover(`text:${REVIEW} >> nth=1`);
  await app.press("role:button[Drag to move, press for the menu]");
  await app.press("role:menuitem[Delete]");
  await app.waitFor(`text:${REVIEW} >> nth=1`, { state: "gone" });
  expect(app.count(`text:${REVIEW}`)).toBe(before);
});

test("+ adds a block below with the menu open", async () => {
  const app = await openDemo(true);
  await app.hover(`text:${REVIEW}`);
  await app.press("role:button[Add a block below]");
  await app.waitFor("role:listbox[Blocks]");
});

test("dragging the handle moves the block above another", async () => {
  const app = await openDemo(true);
  const QUOTE = "Good tools disappear: people should remember the work, not the editor.";
  const index = (text: string) => app.texts().findIndex((t) => t.includes(text));
  expect(index(QUOTE)).toBeGreaterThan(index("This week"));
  await app.hover(`text:${QUOTE}`);
  await app.waitFor("role:button[Drag to move, press for the menu]");
  // Up past the task list and its heading.
  await app.drag("role:button[Drag to move, press for the menu]", { y: -260 });
  await app.wait(300);
  expect(index(QUOTE)).toBeLessThan(index("This week"));
});

/** The index of the first text containing `text`, in the order the document shows them. */
function order(app: { texts(): string[] }) {
  return (text: string) => app.texts().findIndex((t) => t.includes(text));
}

test("every item of a list has a handle that moves it: bulleted, numbered and to-do", async () => {
  const app = await openDemo(true);
  const index = order(app);
  const handle = "role:button[Drag to move, press for the menu]";
  // A bulleted item down past the next one.
  await app.hover("text:Ship the new order ticket to every region");
  await app.waitFor(handle);
  await app.drag(handle, { y: 70 });
  await app.wait(300);
  expect(index("Cut the time to first trade by a third")).toBeLessThan(index("Ship the new order ticket to every region"));
  // The other items stay together and in order.
  expect(index("Cut the time to first trade by a third")).toBeLessThan(index("Move the help center to the new editor"));
  // A to-do item up past the one above it.
  await app.hover("text:Freeze the design of the ticket");
  await app.waitFor(handle);
  await app.drag(handle, { y: -50 });
  await app.wait(300);
  expect(index("Freeze the design of the ticket")).toBeLessThan(index("Review the pricing page copy"));
  // A numbered item down.
  await app.hover("text:Confirm the launch date");
  await app.waitFor(handle);
  await app.drag(handle, { y: 70 });
  await app.wait(300);
  expect(index("Brief the regional leads")).toBeLessThan(index("Confirm the launch date"));
  expect(index("Brief the regional leads")).toBeLessThan(index("Open the beta to five percent of traffic"));
});

test("a list item's menu turns it into another block and + adds an item of the same list", async () => {
  const app = await openDemo(true);
  const handle = "role:button[Drag to move, press for the menu]";
  await app.hover("text:Walk support through the new flow");
  await app.waitFor("role:button[Add a block below]");
  await app.press("role:button[Add a block below]");
  await app.waitFor("role:listbox[Blocks]");
  // The new line is an item of the list: its checkbox shows with the others.
  expect(app.count("role:checkbox")).toBe(5);
  await app.keyboard.press("escape");
  await app.type("label:Document", "Ship it");
  await app.wait(300);
  await app.hover("text:/Ship it");
  await app.waitFor(handle);
  await app.press(handle);
  await app.press("role:menuitem[Delete]");
  await app.wait(400);
  // The item and its checkbox are gone.
  expect(app.count("role:checkbox")).toBe(4);
});

test("a dragged block shows a preview that follows the pointer and a line where it will drop", async () => {
  const app = await openDemo(true);
  await app.hover("text:Good tools disappear: people should remember the work, not the editor.");
  await app.waitFor("role:button[Drag to move, press for the menu]");
  expect(app.count("id:block-ghost")).toBe(0);
  await app.dragAndHold("role:button[Drag to move, press for the menu]", { y: -200 });
  await app.waitFor("id:block-ghost");
  expect(app.texts().filter((t) => t.startsWith("Good tools disappear")).length).toBeGreaterThan(1);
  expect(app.count("id:rich-editor-drop-cursor")).toBe(1);
  await app.drop();
  await app.waitFor("id:block-ghost", { state: "gone" });
  expect(app.count("id:rich-editor-drop-cursor")).toBe(0);
});

test("the arrows keep the highlighted block in view in a list taller than the menu", async () => {
  const app = await openDemo();
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  // Table is the last of fourteen blocks, below what the menu shows at first.
  for (let i = 0; i < 13; i++) await app.keyboard.press("down");
  expect(app.shows("role:option[Table]")).toBe(true);
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
});

test("the pointer over a block of the menu moves the highlight there, and Enter picks it", async () => {
  const app = await openDemo(true);
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  await app.hover("role:option[Heading 2]");
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.type("label:Document", "Plan");
  await app.waitFor("text:Plan");
  // Heading 2 is 24 points (`text-2xl`).
  expect(app.spanStyle("text:Plan").fontSize).toBe(24);
});

test("a pointer resting where the menu opens does not take the highlight, and each opening starts at the first block", async () => {
  const app = await openDemo(true);
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  // The pointer goes over Divider (the highlight follows it) and stays; the menu is closed without a pick.
  await app.hover("role:option[Divider]");
  await app.keyboard.press("escape");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.keyboard.press("backspace");
  // Opened again under the resting pointer: the first block is lit, so Down is Heading 1, not the one after Divider.
  await app.type("label:Document", "/");
  await app.waitFor("role:listbox[Blocks]");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.type("label:Document", "Title");
  await app.waitFor("text:Title");
  // Heading 1 is 30 points (`text-3xl`).
  expect(app.spanStyle("text:Title").fontSize).toBe(30);
});

test("the handle follows the pointer's block as the document scrolls, and goes with Select All", async () => {
  const app = await open("../App.tsx", { platform: "macos", width: 1200, height: 520 });
  await app.press("role:button[Block editor]");
  await app.waitFor("Q4 launch plan");
  const handle = "role:button[Drag to move, press for the menu]";
  await app.hover("text:Ship the new order ticket to every region");
  await app.waitFor(handle);
  // The pointer stays put as the document moves: the handle is the one of the block now under it.
  await app.scroll("id:block-document", 200);
  await app.wait(200);
  expect(app.count(handle)).toBe(1);
  // Over another block, then everything selected: the toolbar shows, not the handle.
  await app.hover("text:Review the pricing page copy");
  await app.waitFor(handle);
  await app.press("Review the pricing page copy");
  await app.keyboard.press("mod+a");
  await app.waitFor("role:toolbar[Format]");
  expect(app.count(handle)).toBe(0);
});

test("a list started right above one of its kind joins it: the numbers run on", async () => {
  const app = await openDemo();
  // A paragraph between the heading and the numbered list, made a list by typing `1. `.
  await app.press("Rollout");
  await app.keyboard.press("end");
  await app.keyboard.press("enter");
  await app.type("label:Document", "1. Pick the owner");
  await app.waitFor("text:Pick the owner");
  // One list of four, not two lists that each start at 1.
  await app.waitFor("text:4.");
  expect(app.count("text:1.")).toBe(1);
});

test("Mod-Shift-Up and Down move the caret's block, a list item among its list, and Mod-D duplicates it", async () => {
  const app = await openDemo();
  const index = order(app);
  // An item of the numbered list, up one place and back.
  await app.press("Brief the regional leads");
  await app.keyboard.press("mod+shift+up");
  await app.wait(200);
  expect(index("Brief the regional leads")).toBeLessThan(index("Confirm the launch date"));
  await app.keyboard.press("mod+shift+down");
  await app.wait(200);
  expect(index("Confirm the launch date")).toBeLessThan(index("Brief the regional leads"));
  // The caret went with the block: typing lands in it.
  await app.keyboard.press("end");
  await app.type("label:Document", "!");
  await app.waitFor("text:Brief the regional leads!");
  // A top-level block past the one below it.
  await app.press("Goals");
  await app.keyboard.press("mod+shift+down");
  await app.wait(200);
  expect(index("Move the help center to the new editor")).toBeLessThan(index("Goals"));
  // A copy right below.
  const before = app.count("text:Goals");
  await app.keyboard.press("mod+d");
  await app.wait(200);
  expect(app.count("text:Goals")).toBe(before + 1);
});

test("the toolbar shows the selection's block as pressed, and the menu pictures the highlighted block", async () => {
  const app = await openDemo(true);
  await app.press("This week");
  await app.keyboard.press("home");
  await app.keyboard.press("shift+end");
  await app.waitFor("role:toolbar[Format]");
  // The heading is level 1 in the document's Markdown (`##` is 2).
  expect(app.count("role:button[Heading 2]")).toBe(1);
  await app.keyboard.press("right");
  await newLine(app);
  await app.type("label:Document", "/");
  await app.waitFor("id:slash-preview");
  // The groups' headings stand over their first blocks.
  expect(app.shows("text:STYLE")).toBe(true);
  expect(app.shows("text:LISTS")).toBe(true);
  await app.type("label:Document", "table");
  await app.waitFor("text:LISTS", { state: "gone" });
  expect(app.shows("text:INSERT")).toBe(true);
});

test("a callout sets blocks apart, and the toolbar links the selection", async () => {
  const app = await openDemo();
  await newLine(app);
  await app.type("label:Document", "/callout");
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.type("label:Document", "Ship on Friday");
  await app.waitFor("text:Ship on Friday");
  // The selection gets a link from the toolbar's field.
  await app.keyboard.press("home");
  await app.keyboard.press("shift+end");
  await app.waitFor("role:toolbar[Format]");
  await app.press("role:button[Link]");
  await app.type("label:Link address", "https://nsh.dev");
  await app.submit("label:Link address");
  // The caret in the link shows its address and actions.
  await app.waitFor("role:button[Edit link]");
  expect(app.shows("text:https://nsh.dev")).toBe(true);
  await app.press("role:button[Remove link]");
  await app.waitFor("role:button[Edit link]", { state: "gone" });
});

test("on a touch screen a bar acts on the caret's block: move, indent, duplicate, delete", async () => {
  const app = await openDemo();
  const index = order(app);
  await app.press("Brief the regional leads");
  await app.press("role:button[Move block up]");
  await app.wait(200);
  expect(index("Brief the regional leads")).toBeLessThan(index("Confirm the launch date"));
  // Indented under the item above it: a nested list numbers it `a.`.
  await app.press("Confirm the launch date");
  await app.press("role:button[Indent]");
  await app.waitFor("text:a.");
  await app.press("role:button[Outdent]");
  await app.waitFor("text:a.", { state: "gone" });
  const before = app.count("text:Confirm the launch date");
  await app.press("role:button[Duplicate block]");
  await app.wait(200);
  expect(app.count("text:Confirm the launch date")).toBe(before + 1);
  await app.press("role:button[Delete block]");
  await app.wait(200);
  expect(app.count("text:Confirm the launch date")).toBe(before);
  // `+` opens the blocks in a new item below.
  await app.press("role:button[Add a block below]");
  await app.waitFor("role:listbox[Blocks]");
});

test("Escape selects the caret's block, which Backspace deletes; columns hold blocks side by side", async () => {
  const app = await openDemo();
  await app.press("Brief the regional leads");
  await app.keyboard.press("escape");
  await app.keyboard.press("backspace");
  await app.waitFor("text:Brief the regional leads", { state: "gone" });
  expect(app.shows("text:Confirm the launch date")).toBe(true);
  // Two columns, typed into one after the other.
  await newLine(app);
  await app.type("label:Document", "/columns");
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  // The caret starts in the first column; Right at its end goes on into the second.
  await app.type("label:Document", "Left side");
  await app.keyboard.press("right");
  await app.type("label:Document", "Right side");
  await app.waitFor("text:Right side");
  const texts = app.texts();
  expect(texts.indexOf("Left side")).toBeGreaterThan(-1);
  expect(texts.indexOf("Left side")).toBeLessThan(texts.indexOf("Right side"));
  // Nothing was typed into the blocks around.
  expect(texts.includes("Numbers to watch")).toBe(true);
  expect(texts.includes("Open the beta to five percent of traffic")).toBe(true);
});

test("the toolbar colors the selection's text, and Default takes the color off", async () => {
  const app = await openDemo();
  await app.press(REVIEW);
  await app.keyboard.press("home");
  await app.keyboard.press("shift+end");
  await app.waitFor("role:toolbar[Format]");
  const plain = app.spanStyle(`text:${REVIEW}`).color;
  await app.press("role:button[Text color]");
  await app.press("role:button[Red]");
  expect(app.spanStyle(`text:${REVIEW}`).color).not.toBe(plain);
  await app.press("role:button[Text color]");
  await app.press("role:button[Default color]");
  expect(app.spanStyle(`text:${REVIEW}`).color).toBe(plain);
});

test("Escape then Shift-Down selects a run of blocks, which Backspace deletes; Shift-arrows select text otherwise", async () => {
  const app = await openDemo();
  await app.press("Confirm the launch date");
  await app.keyboard.press("escape");
  await app.keyboard.press("shift+down");
  await app.keyboard.press("shift+down");
  // Back up one: the run is the first two items.
  await app.keyboard.press("shift+up");
  await app.keyboard.press("backspace");
  await app.waitFor("text:Brief the regional leads", { state: "gone" });
  expect(app.count("text:Confirm the launch date")).toBe(0);
  expect(app.shows("text:Open the beta to five percent of traffic")).toBe(true);
  // With a caret, Shift-Down selects text: the toolbar shows.
  await app.press(REVIEW);
  await app.keyboard.press("shift+down");
  await app.waitFor("role:toolbar[Format]");
});

test("a toggle hides and shows its body with its arrow", async () => {
  const app = await openDemo();
  await newLine(app);
  await app.type("label:Document", "/toggle");
  await app.keyboard.press("enter");
  await app.waitFor("role:listbox[Blocks]", { state: "gone" });
  await app.type("label:Document", "Details");
  await app.keyboard.press("right");
  await app.type("label:Document", "Hidden words");
  await app.waitFor("text:Hidden words");
  // What the screen shows (a hidden view is still made, so selectors find it).
  const shown = (text: string) => app.texts().includes(text);
  await app.press("role:button[Collapse]");
  await app.waitFor("role:button[Expand]");
  expect(shown("Hidden words")).toBe(false);
  expect(shown("Details")).toBe(true);
  await app.press("role:button[Expand]");
  await app.waitFor("role:button[Collapse]");
  expect(shown("Hidden words")).toBe(true);
});

test("a list item dragged to the right goes under the item above it, and to the left comes back out", async () => {
  const app = await openDemo(true);
  const handle = "role:button[Drag to move, press for the menu]";
  await app.hover("text:Brief the regional leads");
  await app.waitFor(handle);
  // Across, staying on its line: nested, a numbered list inside a numbered list letters it.
  await app.drag(handle, { x: 60 });
  await app.waitFor("text:a.");
  expect(app.texts().includes("Brief the regional leads")).toBe(true);
  await app.hover("text:Brief the regional leads");
  await app.waitFor(handle);
  await app.drag(handle, { x: -60 });
  await app.waitFor("text:a.", { state: "gone" });
});

test("a run of blocks moves and duplicates as one", async () => {
  const app = await openDemo();
  const index = order(app);
  await app.press("Confirm the launch date");
  await app.keyboard.press("escape");
  await app.keyboard.press("shift+down");
  // The first two items go below the third, in their order.
  await app.keyboard.press("mod+shift+down");
  await app.wait(200);
  expect(index("Open the beta to five percent of traffic")).toBeLessThan(index("Confirm the launch date"));
  expect(index("Confirm the launch date")).toBeLessThan(index("Brief the regional leads"));
  // Still selected: they go back up together.
  await app.keyboard.press("mod+shift+up");
  await app.wait(200);
  expect(index("Brief the regional leads")).toBeLessThan(index("Open the beta to five percent of traffic"));
  // A copy of both.
  await app.keyboard.press("mod+d");
  await app.wait(200);
  expect(app.count("text:Confirm the launch date")).toBe(2);
  expect(app.count("text:Brief the regional leads")).toBe(2);
});

test("a list item carried across says what the drop will do, and a toggle nested in a callout has its arrow", async () => {
  const app = await openDemo(true);
  const handle = "role:button[Drag to move, press for the menu]";
  await app.hover("text:Brief the regional leads");
  await app.waitFor(handle);
  await app.dragAndHold(handle, { x: 60 });
  await app.waitFor("text:Drop to indent");
  await app.drop();
  await app.waitFor("text:a.");
  // A toggle inside a callout.
  await newLine(app);
  await app.type("label:Document", "/callout");
  await app.keyboard.press("enter");
  await app.type("label:Document", "/toggle");
  await app.keyboard.press("enter");
  await app.type("label:Document", "Inner");
  await app.waitFor("role:button[Collapse]");
});
