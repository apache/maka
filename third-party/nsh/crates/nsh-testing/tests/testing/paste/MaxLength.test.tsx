import { expect, open, test } from "nsh/test";

// A paste longer than `maxLength` goes in clipped to what fits, as a
// browser's `maxlength` clips it, never as a whole or not at all.
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

  test(`a paste into the ${input} keeps an emoji whole`, async () => {
    const app = await open("./MaxLength.tsx");
    await app.paste(`id:${input}`, { text: "ABCDEFGHI😀KLM" });
    expect(app.value(`id:${input}`)).toBe("ABCDEFGHI");
  });
}
