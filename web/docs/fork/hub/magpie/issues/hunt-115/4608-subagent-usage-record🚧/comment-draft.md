Diagnosis first: the ledger path for a subagent's tokens checks out locally, so before changing anything I'd like a few details from your setup.

What I verified on today's `main` (`9d08993c`) with a fake upstream that reports usage:

- A subagent request Codex sends (`x-openai-subagent: collab_spawn`, the luna model bare, e.g. `gpt-6-luna`) is written to `usage.jsonl` whether or not a model is set for Codex's subagents: relayed as `model: gpt-6-luna` with the tokens the upstream reported, or moved onto the model set for them with the luna name kept as `requested`. Both scenes recorded `input 11, output 3` from the fake reply.
- The Usage page's summary counts every non-rejected record into its model row, so a luna row would show unless the row itself is missing or zero.
- The stream reader takes usage from `response.completed` (top-level or nested `response.usage`) — nothing subagent-specific drops it.

What I could not check locally is a real ChatGPT sign-in. If the backend answers a sealed subagent task without a usage block, magpie would still record the call but with 0 tokens — which would look exactly like what you describe. So could you check:

1. In `usage.jsonl` in magpie's data folder (`~/.config/magpie/` on Linux/macOS), any line naming your luna model (`"model":"gpt-6-luna"` or the id you saw)? Even a line with zero tokens tells us the request arrived and the backend reported nothing.
2. On the Routing page, does the subagent's request appear, tagged `collab_spawn`?
3. On magpie's Agents page, is a model set for Codex's subagents? If one is, the subagent's spend lands under that model's row, not under luna.
4. Are sol and luna Codex's own models (a ChatGPT sign-in) or models of a provider you added in magpie — and which magpie version?

With (1) especially I can tell whether this is a missing record, a zero-token reply from the backend, or the spend sitting under another model's name.
