import { expect, open, test } from "nsh/test";

test("span styles follow ids and reject an emptied span", async () => {
  const app = await open("./Spans.tsx");
  const style = app.spanStyle("id:guide");
  expect(style).toEqual({
    color: "#123456ff",
    backgroundColor: "#fedcbaff",
    fontSize: 18,
    fontWeight: 700,
    italic: true,
    underline: true,
    lineThrough: true,
  });
  expect(app.spanStyle("id:paragraph >> text:guide")).toEqual(style);
  await app.press("Rename ID");
  expect(() => app.spanStyle("id:guide")).toThrow(/no span/);
  expect(app.spanStyle("id:renamed")).toEqual(style);
  await app.press("Empty span");
  expect(() => app.spanStyle("id:renamed")).toThrow(/no characters/);
  expect(app.spanStyle("text:See").underline).toBe(false);
});
