import { expect, open, test } from "nsh/test";

// A paste longer than `maxLength` goes in clipped to what fits, as a
// browser's `maxlength` clips it, never as a whole or not at all.
// `maxLength` counts characters (Unicode scalar values): an emoji is one,
// and a cut never splits what the user sees as one character.
// `nsh test crates/nsh-testing/tests/testing/paste/MaxLength.test.tsx --target ios`

for (const input of ["field", "area"]) {
  test(`a long paste fills the ${input} up to its maxLength`, async () => {
    const app = await open("./MaxLength.tsx");
    await app.type(`id:${input}`, "12345");
    await app.paste(`id:${input}`, { text: "ABCDEFGHIJ" });
    expect(app.value(`id:${input}`)).toBe("12345ABCDE");
    await app.paste(`id:${input}`, { text: "KLM" });
    expect(app.value(`id:${input}`)).toBe("12345ABCDE");
  });

  test(`a paste into the ${input} counts an emoji as one character`, async () => {
    const app = await open("./MaxLength.tsx");
    await app.paste(`id:${input}`, { text: "ABCDEFGHI😀KLM" });
    expect(app.value(`id:${input}`)).toBe("ABCDEFGHI😀");
  });

  test(`a paste into the ${input} keeps an emoji with its skin tone whole`, async () => {
    const app = await open("./MaxLength.tsx");
    await app.paste(`id:${input}`, { text: "ABCDEFGHI👍🏽" });
    expect(app.value(`id:${input}`)).toBe("ABCDEFGHI");
  });
}

test("800 emoji typed into a maxLength of 1500 all go in", async () => {
  const app = await open("./MaxLength.tsx");
  const emoji = "😀".repeat(800);
  await app.type("id:long", emoji);
  expect(app.value("id:long")).toBe(emoji);
  // 700 more characters fit, then nothing.
  await app.paste("id:long", { text: "😀".repeat(800) });
  expect(app.value("id:long")).toBe("😀".repeat(1500));
  await app.type("id:long", "a");
  expect(app.value("id:long")).toBe("😀".repeat(1500));
});
