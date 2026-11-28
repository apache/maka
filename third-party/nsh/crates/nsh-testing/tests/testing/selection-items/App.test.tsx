import { open, test } from "nsh/test";

// Rows' texts are 154 points wide (20 characters of the test engine): a
// drag starts at offset 10, and 46 points are 6 characters.

test("the same text in two rows names the row it is in", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:text-b", { x: -45, y: 0 });
  await app.waitFor('Ends: b@10 b@4 "tests "');
  await app.drag("id:text-a", { x: -45, y: 0 });
  await app.waitFor('Ends: a@10 a@4 "tests "');
});

test("a drag forward keeps the anchor where it started", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:text-b", { x: 46, y: 0 });
  await app.waitFor('Ends: b@10 b@16 "passed"');
});

test("a drag across rows has its ends in each row", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.drag("id:text-b", { x: 0, y: -37 });
  await app.waitFor('Ends: b@10 a@10 "passed.\\n\\nAll tests "');
});

test("the offset counts the item's earlier paragraphs as a copy gives them", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  // The TextView is 300 points wide: the drag starts past the end of the
  // paragraph (offset 12) and goes back to offset 6.
  await app.drag("text:Second para.", { x: -100, y: 0 });
  await app.waitFor('Ends: c@25 c@19 " para."');
});

test("a row inserted above the selection leaves its ends in their items", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.press("id:insert");
  await app.drag("id:text-b", { x: -45, y: 0 });
  await app.waitFor("text:Inserted above.");
  // Shift extends the selection from its anchor, which stayed in row b.
  await app.keyboard.down("shift");
  await app.drag("id:text-a", { x: -45, y: 0 });
  await app.waitFor('Ends: b@10 a@4 "tests passed.\\n\\nAll tests "');
});

test("a row replaced under the selection names the item now there", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.press("id:replace");
  await app.drag("id:text-b", { x: -45, y: 0 });
  await app.waitFor("id:text-d");
  await app.keyboard.down("shift");
  await app.drag("id:text-a", { x: -45, y: 0 });
  await app.waitFor('Ends: d@10 a@4 "tests passed.\\n\\nAll tests "');
});

test("a selection's start counts the blank line before a paragraph", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  // From past the end of "Second para." back to its start: the copy of
  // the whole view has the two rows and "First para." with a blank line
  // after each before it (17 + 2 + 17 + 2 + 11 + 2).
  await app.drag("text:Second para.", { x: -200, y: 0 });
  await app.waitFor('Ends: c@25 c@13 "Second para."');
  await app.waitFor("Start: 51");
});

test("an anchor scrolled out of view keeps its item when the selection extends", async () => {
  const app = await open("./Long.tsx", { platform: "macos" });
  await app.drag("id:text-r1", { x: -45, y: 0 });
  await app.waitFor("Ends: r1@10 r1@4");
  // Far enough that the anchor's row would be recycled for a row below.
  await app.scroll("id:list", 1500);
  await app.waitFor("id:text-r48");
  await app.keyboard.down("shift");
  await app.drag("id:text-r48", { x: -45, y: 0 });
  await app.waitFor("Ends: r1@10 r48@4");
});

test("a list without a keyExtractor names its items by key, id or index", async () => {
  const app = await open("./Kinds.tsx", { platform: "macos" });
  await app.drag("text:Row with an id.", { x: -45, y: 0 });
  await app.waitFor('Ends: x@10 x@4 "with a"');
  await app.drag("text:Row with a key.", { x: -45, y: 0 });
  await app.waitFor('Ends: k@10 k@4 "with a"');
  await app.drag("text:Row by its index.", { x: -45, y: 0 });
  await app.waitFor('Ends: 2@10 2@4 "by its"');
});

test("an end outside the list leaves its item out", async () => {
  const app = await open("./Kinds.tsx", { platform: "macos" });
  // From the title down into the first row.
  await app.drag("text:Transcript title", { x: 0, y: 25 });
  await app.waitFor('Ends: - x@10 " title\\n\\nRow with a"');
});

test("an end in an item with a list marker counts the marker as a copy does", async () => {
  const app = await open("./Kinds.tsx", { platform: "macos" });
  // The item copies as "• First item\n• Second item": "Second item"
  // starts at 13 with its marker, and a selection from its start takes
  // the marker along.
  await app.drag("text:Second item", { x: -200, y: 0 });
  await app.waitFor('Ends: m@26 m@13 "• Second item"');
});

test("an end in a nested list names the innermost item", async () => {
  const app = await open("./Kinds.tsx", { platform: "macos" });
  await app.drag("text:Inner two.", { x: -45, y: 0 });
  await app.waitFor('Ends: i2@10 i2@4 "r two."');
});

test("an end in a Rust component's list names the item of the list around it", async () => {
  const app = await open("./Kinds.tsx", { platform: "macos" });
  // The tree's rows are a list of its own, which the app does not name:
  // the end names the row of the app's list the tree is in, and counts in
  // the copy of that row's item.
  await app.drag("text:Tree leaf two.", { x: -45, y: 0 });
  // "Tree leaf one.\n" before it in the row's copy.
  await app.waitFor('Ends: t@25 t@19 " leaf "');
});

test("an end in a row whose keyExtractor throws is left out", async () => {
  const app = await open("./Kinds.tsx", { platform: "macos" });
  await app.drag("text:Row without a key.", { x: -45, y: 0 });
  await app.waitFor('Ends: b1@10 b1@4 "withou"');
  await app.press("id:break");
  // The exception is the app's, reported as any it throws: the step that
  // made it fails.
  let threw = "";
  try {
    await app.drag("text:Row without a key.", { x: -35, y: 0 });
  } catch (e) {
    threw = String(e);
  }
  if (!threw.includes("no key for this row")) throw new Error(`the drag did not report the exception: ${threw}`);
  // The list names no item for the row now: the event leaves both ends
  // out rather than guess one.
  await app.waitFor('Ends: - - "ithou"');
});
