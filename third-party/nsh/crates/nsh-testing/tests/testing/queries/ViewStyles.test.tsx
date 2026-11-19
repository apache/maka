import { expect, open, test } from "nsh/test";

test("view styles read background and opacity, through the views around", async () => {
  const app = await open("./ViewStyles.tsx");
  expect(app.viewStyle("id:card")).toEqual({
    backgroundColor: "#336699ff",
    opacity: 1,
    effectiveOpacity: 0.5,
  });
  expect(app.viewStyle("id:plain")).toEqual({ opacity: 1, effectiveOpacity: 0.5 });
  expect(app.viewStyle("id:missing")).toBeNull();
  await app.press("Dim");
  const card = app.viewStyle("id:card")!;
  expect(Math.round(card.opacity * 100)).toBe(40);
  expect(Math.round(card.effectiveOpacity * 100)).toBe(20);
});
