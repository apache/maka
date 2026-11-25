import { expect, open, test } from "nsh/test";

test("span styles follow ids and reject an emptied span", async () => {
  const app = await open("./Spans.tsx");
  const style = app.spanStyle("id:guide");
  expect(style).toEqual({
    color: "#123456ff",
    backgroundColor: "#fedcbaff",
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 27,
    letterSpacing: 2,
    fontFamily: "Inter, sans-serif",
    italic: true,
    underline: true,
    lineThrough: true,
  });
  expect(app.spanStyle("id:paragraph >> text:guide")).toEqual(style);
  // Multiples and ems resolve against the span's own font size.
  const loose = app.spanStyle("id:loose");
  expect(loose.lineHeight).toBe(20);
  expect(loose.letterSpacing).toBeGreaterThan(0.249);
  expect(loose.letterSpacing).toBeLessThan(0.251);
  // Unset: the font's natural line height and the system font.
  const plain = app.spanStyle("text:See");
  expect(plain.lineHeight).toBeUndefined();
  expect(plain.letterSpacing).toBe(0);
  expect(plain.fontFamily).toBeUndefined();
  await app.press("Rename ID");
  expect(() => app.spanStyle("id:guide")).toThrow(/no span/);
  expect(app.spanStyle("id:renamed")).toEqual(style);
  await app.press("Empty span");
  expect(() => app.spanStyle("id:renamed")).toThrow(/no characters/);
  expect(app.spanStyle("text:See").underline).toBe(false);
});
