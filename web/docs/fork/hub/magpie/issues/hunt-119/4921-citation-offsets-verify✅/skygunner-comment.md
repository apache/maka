Reproduced and fixed on a branch — thanks for the exceptionally complete report (routing log + rollout shape + minimal repro), it made the root cause traceable end to end.

**Root cause.** Magpie relays a whole Responses reply from another vendor as that vendor's own events, annotations included. Ark writes `url_citation` with no `start_index`/`end_index`; Codex stores what it is handed, and when the thread next lands on a `codex/*` member the replayed history fails OpenAI's schema check — `Missing required parameter: 'input[N].content[0].annotations[0].start_index'` — on every retry, forever. Same class as #2855: what magpie hands a client must be something magpie could send again. #3887's `encrypted_content` strip doesn't cover annotations.

**Fix** (drops the unsendable citation at both seams, the way the reasoning-item fix did):

- **Reply side**: a whole reply streamed as the vendor's events drops an annotation lacking either offset in every place a client reads a citation — the `response.output_text.annotation.added` events, `content_part.done`, `output_item.done`, and the `response.completed` object (`dropOffsetlessCitations` in `internal/gateway/whole_stream.go`). The text, and a citation that carries its offsets, go exactly as the vendor wrote them.
- **Request side** (`withoutOffsetlessCitations` in `internal/gateway/codex_backend.go`, beside `withoutReasoningText` of #1411): such an annotation leaves the replayed history on its way to the ChatGPT backend — on Codex's own sign-in and compaction relay, on a `codex/*` group member / openai.com / Azure upstream in the provider loop, and, where a relay in front of the backend names the parameter, the request is asked again without it and the provider marked so it is never sent one again. **A thread already poisoned heals on its next turn — no new thread, no manual rollout surgery.** A turn whose items name no `"annotations"` is not decoded (the #1532 scan discipline holds).

Dropping rather than filling `0/len`: the schema wants real offsets, and a vendor that omits them says nothing about where the citation sits — a filled pair would highlight text the citation is not about; dropping keeps the text, which is what the thread needs.

**Verification** (branch `fix/4921-citation-offsets`, commit `fcea11649`, on top of main `8abdf53a8`):

| What | Result |
|---|---|
| The three new tests on clean main (ablation) | red — the citation relays to the client, and both the relay and the ChatGPT backend answer with your exact 400 |
| Same tests on the branch | green: reply-side drop, retry-without on the relay, pre-strip on the backend, cited-with-offsets kept in all four places |
| `TestCodexRewritesAsBefore` / `...LeaveTurnUndecoded` + fuzz | ok — the rewrite is held to its scan, an unmarked turn is not decoded |
| gofmt / `go vet -tags nogui` (linux, windows) / `go build -tags nogui` | clean |

**Boundary**: tested against the annotation shape you captured via a fake upstream that answers with your exact error; not verified against a real Ark account or a real poisoned Codex-desktop thread (the mechanism — replay-side strip — is the same one that healed #2855's threads). A vendor that *streams* offsetless citations byte-for-byte still plants them, but the replay-side strip heals those threads the same way; if one shows up, the same rule goes into the stream tidy.

This is a fork branch, offered for review; not a claim on the issue.

