**What's wrong**

@1xyh2's report: with Mistral configured, vscode and codex fail with

```
422 Unprocessable Entity: {"detail":[{"type":"extra_forbidden","loc":["body","messages",2,"assistant","reasoning_content"],"msg":"Extra inputs are not permitted","input":"The user just said \"你好啊哦\" ..."}]}
```

— an earlier assistant turn's thinking was relayed back to Mistral in `reasoning_content`, a field Mistral's strict schema refuses on its messages.

**Root cause**

This is exactly #494, and it is already fixed on main. Commit `6b89fb22f` ("an earlier assistant turn's thinking goes to Mistral as the thinking part Mistral itself returns, and a vendor that turns it away inside messages is asked again without it") landed on 2026-10-02 and first shipped in **v0.1.616**; the current latest release is v0.1.2863. The error shape in this report — `extra_forbidden` at `["body","messages",2,"assistant","reasoning_content"]` — is verbatim the one #494 reproduces and fixes.

Since that fix, on a build with it:

- A relayed Chat request to the Mistral preset (or api.mistral.ai) has the assistant turn's `reasoning_content` / `reasoning` / `reasoning_details` converted into the typed `{"type":"thinking", ...}` content part Mistral itself returns and accepts (`mistralThinking`), so the thinking stays in context and never trips the schema.
- Any other Chat upstream that answers `extra_forbidden` located inside the messages for one of those fields is asked once more with the field left out, and not sent it again for that provider from then on (`refusedInMessages`) — this covers a Mistral fronted by a custom relay URL too.
- A translated request (e.g. Codex's Responses API to a Chat upstream) writes `reasoning_content` only for hosts/models known to replay it (DeepSeek, Kimi, Qoder, Command Code) — not for Mistral.

**The fix**

No new patch — the fix is in the tree; a build older than v0.1.616 would show exactly this error. Upgrading should clear it.

<details>
<summary>Landed fix reference</summary>

```
commit 6b89fb22f46840d9bc57707b5283186868dc053b (2026-10-02, #494)
first release containing it: v0.1.616
tests in the tree:
  internal/gateway/mistral_reasoning_test.go  TestMistralReasoningAsThinking (the issue's request, and a tool-call turn)
  internal/gateway/mistral_reasoning_test.go  TestMessageReasoningRefused (retry without the field, then it is not sent again)
  internal/gateway/mistral_extra_fields_test.go  TestMistralRefusesStore (#393's top-level fields)
```

</details>

Could you say which magpie version you are on? If it is older than v0.1.616, upgrading should clear this. If you still see the 422 on a current build, please say the version and whether the provider is the Mistral preset or a custom URL (a relay in front of Mistral) — both paths are covered, so a current build should not surface this error.

**Verification**

All on upstream/main tip `1e1068c86`, darwin/arm64, `go test -tags nogui ./internal/gateway/`:

| Check | Result |
| --- | --- |
| TestMistralReasoningAsThinking (assistant thinking to the Mistral preset as the thinking part) | PASS |
| TestMessageReasoningRefused (another Chat upstream refuses the field: retry without it, then not sent again) | PASS |
| TestMistralRefusesStore (top-level unknown fields) | PASS |
| Probe reproducing this report's exact request (messages[2] an assistant turn with `reasoning_content`, the report's own reasoning text) against the Mistral preset, whole reply and streamed | PASS — no `reasoning_content` reaches the upstream; converted to the thinking part in the first ask |
| Same probe against a plain Chat provider that refuses like Mistral, whole reply and streamed | PASS — first ask 422, retry without the field 200, then the field is not sent again |

**Not verified**

Against a live api.mistral.ai account (fake-upstream tests only). The reporter's build and provider configuration are unknown (asked above) — the verdict that the build predates v0.1.616 is inferred from the error being the one #494 fixed and from the current tree refusing to send the field in every configuration probed. What "dsh" is and why it worked was not inspected; its working while vscode/codex failed is consistent with requests that carry no `reasoning_content` on assistant turns (inference, not verified).

AI use: analysis and probe test written by GLM-5.3-Flash (ZCode), posted by ggbdpq; no code changes proposed.

*AI-written analysis comment (no patch); account ggbdpq.*
