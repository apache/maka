// A component's `tooltip` host prop shows on hover, as a view's does (#1274).
import { expect, open, test } from "nsh/test";

const app = () => open("./fixtures/component-tooltip.tsx", { width: 800, height: 600, platform: "linux" });

test("a Button's tooltip shows on hover and the button still presses", async () => {
  const a = await app();
  await a.hover("label:button");
  await a.wait(1200);
  expect(a.texts().includes("tip on button")).toBe(true);
  await a.press("label:button");
  expect(a.texts().includes("presses 1")).toBe(true);
});

test("a disabled Button's tooltip shows too", async () => {
  const a = await app();
  await a.hover("label:disabled");
  await a.wait(1200);
  expect(a.texts().includes("tip on disabled")).toBe(true);
});
