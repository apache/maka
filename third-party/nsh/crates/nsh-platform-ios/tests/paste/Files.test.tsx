// A file that is no image reaches `onPaste` with its name, type and bytes,
// as a document copied in Files does: an item that offers its data under
// the document's type (no file URL) and suggests its name. The path is from
// the repository's root, where `nsh test` runs:
// `nsh test crates/nsh-platform-ios/tests/paste/Files.test.tsx --target ios`
import { open, test } from "nsh/test";

test("a pasted document reaches onPaste with its name and type", async () => {
  const app = await open("./App.tsx");
  await app.paste("id:field", { files: ["crates/nsh-platform-ios/tests/paste/report.pdf"] });
  await app.waitFor("text:pasted:report.pdf application/pdf 77");
});
