import { expect, open, test } from "nsh/test";

test("layout and the accessibility tree read what is on screen", async () => {
  const app = await open("./Layout.tsx");
  const box = app.layout("id:box")!;
  expect([box.width, box.height, box.hidden, box.clipped]).toEqual([80, 40, false, false]);
  expect(box.x - app.layout("id:panel")!.x).toBe(10);
  expect(app.layout("id:wide")!.clipped).toBe(true);
  expect(app.layout("id:missing")).toBeNull();

  const send = app.accessibility("label:Send")!;
  expect(send.role).toBe("button");
  expect(send.disabled).toBe(true);
  expect(send.children.map((c) => c.label)).toEqual(["Arrow"]);
  expect(app.accessibility("id:missing")).toBeNull();

  const tree = app.accessibility()!;
  expect(tree.role).toBeUndefined();
  expect(tree.children.map((c) => c.role)).toEqual(["button", "checkbox"]);
  expect(tree.children[1].checked).toBe("true");
});
