Following up on the patch I posted here on Nov 8 (`fix/5452-pdf-translation-loss`, head `0e94896c7`, no reply yet): refreshed onto today's `upstream/main` and extended for a shape it missed. Nothing upstream has taken the face — the video work (#6135) reads an `input_file` of a *video* alone and its commit says so in words: "Not changed: PDFs (Messages document, Responses input_file of a PDF, a Chat file of a PDF) stay as #5452 says."

**Branch:** [`hunt-20261112-t1-5452`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5452) @ `d0090b3c3458e096` — one commit on current `upstream/main` (`7dbfc9f2f`). Patch: `afa3ef2f80a2ff86` (sha256[:16]).

**What changed since the Nov 8 post**

- Rebased over #6135's video machinery, which lands in the same regions (`responsesParts`' `input_file` case, `readAnthropic`'s blocks, the builders): a video still rides the video machinery first — `videoFileType` → `videoPart` — and every other file, a PDF say, parses into a file part on top of it. All of #6135's video tests pass with the patch in place.
- One real gap of the Nov 8 version, fixed: an `input_file` as a *message content part* carries its fields flat (`{"type":"input_file","file_data":…,"filename":…}`, the shape the report's case C sends and the OpenAI shape has), and the old `responsesParts` case only read a Chat-style nested `file: {…}` object — the flat part would still have been dropped. Both shapes parse now (`TestResponsesInputFilePartSurvivesTranslation`, `flat` and `nested`, red on `873b4987e` with the tests alone).

**Verification on `7dbfc9f2f`** (go per go.mod, darwin)

| Check | Result |
| --- | --- |
| `TestResponsesInputFileSurvivesTranslation` (standalone input_file item) | red at `873b4987e` (`the input_file was dropped: []`), pass after |
| `TestResponsesInputFilePartSurvivesTranslation` (flat + nested content parts — new) | red at `873b4987e` (both subtests: `the input_file was dropped`), pass after |
| `TestAnthropicDocumentSurvivesTranslation` | red at `873b4987e` (`the document block was dropped`), pass after |
| `TestChatFileRidesToResponsesAndAnthropic` | red at `873b4987e`, pass after |
| `go test ./internal/gateway` (full package, with #6135's video suite) | ok 1087.4s, zero failures |
| targeted `-race -count=2` over the file/translation family | ok |
| `gofmt`, `go vet` | clean |
| `GOOS=linux GOFLAGS=-tags=nogui go build ./...`, same for windows | ok |
| `git am` on a fresh checkout of `7dbfc9f2f` | applies clean, tree byte-identical to the branch's |
| Ablations (each restored, then green) | the `input_file` file branch out of `responsesParts`: both part shapes drop again — red; the Messages `document` write out: the placeholder returns, `anthropic body lost the file` — red; the `document` case out of `readAnthropic`: `the document block was dropped` — red |

**Siblings**: `rg -n "hasSealedAgentMessage|attachmentText|input_file|document"` over the translators — the Chat encoder keeps telling of the file rather than carrying it (#934: a 400 there loses the whole turn), the Claude subscription line renders text to its CLI (no PDF either way), Gemini's inline data rode already and its tests hold (`TestGeminiNonImageFileTranslation`, expectations split: inline rides, a referenced `fileUri` is told of), the video machinery is left exactly as #6135 built it (its suite passes unchanged).

**Not verified**: the reporter's live ChatGPT API account; a real Messages/Responses upstream taking the PDF (the fake-level harness replays the shapes; the report's own probe — a corrupt `input_file` answered upstream with 400 `invalid_file` — stands for the vendor taking the field).

---
**Source**: reported in #5452 (ProgramerLiang's report, live-tested); the loss reproduced here is at the assertion level above.

**Red without the fix** (base `873b4987e`, new tests kept, product files reverted): the four failures quoted in the table. With the fix: `ok`.

**Siblings**: listed above.

**When the read fails**: `chatFile` and the `input_file` case read what the body carries and leave out what they can't read, as before — an unreadable part is dropped, not invented; nothing new is inferred from a bad part.

**Not verified**: real ChatGPT API account, real upstream taking the field.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: a PDF survives translation (#5452) — git am applies it as is; SHA-256 first 16: afa3ef2f80a2ff86</summary>

```
(fenced format-patch full text)
```

</details>
