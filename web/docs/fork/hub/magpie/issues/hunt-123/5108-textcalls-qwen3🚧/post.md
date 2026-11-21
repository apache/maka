**Stepping aside — the reporter already has this patch**

I verified the report against current `main` (tip `1e1068c86`, `internal/gateway/textcalls.go`); every claim in the issue holds:

- In `parseTextCalls`, a `<tool_call>` whose next non-blank byte is `<` has its opener dropped and the rest re-read (the comment there: "no JSON after it: DeepSeek's own tags, an invoke or the closes of one"). No reader knows `<function=NAME>`: `paramCall` wants a `{"name": …}` head first (`paramHead`) — its parameter loop already accepts Qwen's `<parameter=k>` spelling (`paramOpen`), it just never gets reached; `hermesCall` wants JSON; `glmCall` wants a bare name; `dsmlCall` wants `<｜DSML｜invoke name="…">`. `textCallMarks` has no `<function=` entry either. So the Qwen3-Coder block fails every reader, `ok` comes back false, and the held text goes out unchanged with `finish_reason: stop` — the turn ends with the block as the answer.
- On the strategy question (should the recovery only restore calls of offered tools): that is already the convention here. Every reader gates on the offered-tools set — `paramCall`, `glmCall` and `dsmlCall` each begin with `if !names[...] { return false }` — and a block naming an unknown tool stays text by design (the original recovery commit, `bbc89f9e2`, spells this out). So the half of the reporter's blocks naming unoffered tools (e.g. `<function=teamhub message send>`) staying text falls out of the same gate a `qwenCall` reader would use; no new policy is needed, and the suggested fix follows the house rule exactly.

LeoXing1996 states in the issue they already have this fix — a `qwenCall` reader plus the listed tests, passing on `5026525` — and offered to open a PR. That's the right owner for the change; a second patch for the same reader in the same file would only compete with theirs, so I'm stepping aside rather than taking the issue. Looking forward to the patch.

One small note for whoever reviews it: in this template the closes (`</parameter>`, `</function>`, `</tool_call>`) are plain text the model writes, not dropped tokens like DeepSeek's — so, as the reporter says, requiring them is reasonable, and a truncated block failing the parse (and staying text) matches how the existing readers treat cut-off blocks.

Credit to LeoXing1996 for the report and the evidence (86 of 184 benchmark tasks ending early, about half naming offered tools).

*Not verified: the reporter's patch itself (not shared yet). Beyond reading the code at `1e1068c86` and checking the repo for an existing PR touching this issue (none), nothing was run.*

*AI-written analysis by ggbdpq (GLM-5.3-Flash via ZCode).*
