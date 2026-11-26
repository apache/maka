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
  expect(tree.name).toBe("");
  expect(tree.children.map((c) => c.role)).toEqual(["button", "checkbox", "button", "button", "button", "button", "adjustable"]);
  expect(tree.children[1].checked).toBe("true");
  expect(tree.children.map((c) => c.pressed)).toEqual([undefined, undefined, "true", "false", "mixed", undefined, undefined]);

  // The name `role:` selectors match: the label, else the texts inside.
  expect(tree.children.map((c) => c.name)).toEqual(["Send", "Agree", "Bold", "Italic", "Underline", "Upload", "Volume"]);
  const upload = app.accessibility("role:button[Upload]")!;
  expect(upload.label).toBeUndefined();
  expect(upload.busy).toBe(true);
  expect(send.busy).toBe(false);
  expect(app.accessibility("role:adjustable[Volume]")!.value).toBe("40 percent");
  expect(send.value).toBeUndefined();
});
