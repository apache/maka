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

// A document larger than the input's `pasteMaxSize` is not copied out of
// the pasteboard: `onPaste` names it in `tooLarge`, with its type and size.
test("a pasted document over pasteMaxSize reaches onPaste unread", async () => {
  const app = await open("./App.tsx");
  await app.paste("id:limited", { files: ["crates/nsh-platform-ios/tests/paste/report.pdf"] });
  await app.waitFor("text:limited:read no files unread report.pdf application/pdf 77");
});

// An image over the limit is typed from its first bytes, as a screenshot
// is named when it is read.
test("a pasted image over pasteMaxSize reaches onPaste unread", async () => {
  const app = await open("./App.tsx");
  await app.paste("id:limited", { files: ["examples/gallery/logo@2x.png"] });
  await app.waitFor("text:limited:read no files unread image.png image/png 8608");
});
