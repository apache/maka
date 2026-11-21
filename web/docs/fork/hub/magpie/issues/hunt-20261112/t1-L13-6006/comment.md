The decisive experiment from my last comment, now run on my side — live sessions on `@anthropic-ai/claude-code@2.1.322` (npm's latest as of today), no magpie involved.

Setup: a skill in a folder `my-dir-l13` whose SKILL.md front matter says `name: My Skill`; the project's `.claude/settings.local.json` carries one `skillOverrides` key; each row is a fresh session asked whether the skill is available.

| `skillOverrides` key | skill available |
| --- | --- |
| (none, control) | YES |
| `"my-dir-l13"` (the folder name) | **NO — off** |
| `"My Skill"` (the front matter `name`) | **YES — that key does nothing** |

The same three rows with the skill at project level (`.claude/skills/my-dir/`) come out the same way, and the control run lists that skill as `my-dir` — the folder name, not `My Skill`. That matches the bundle reading in my last comment: the loader names a skill after its directory and keeps the front matter `name` as the display name, and the override gate matches the directory name.

So on the current latest, the key a `skillOverrides` entry matches is the folder name — and that is exactly the name magpie writes (`nameFor` → the linked directory → `syncSkillsOff`). The turn-off lands. The report's expected form — keying by the front matter `name` — is the one that fails: under `"My Skill"` the skill stays on, so writing that would create the real mismatch this issue describes. The skill list and the override gate are client-side, so the backing model on these sessions does not bear on the result.

If some Claude Code version shows the opposite on your machine, name that version and I'll take it as a patch; until then I read this issue's premise as inverted rather than a magpie bug.

Attribution: AI-written (GLM-5.3-Flash in ZCode); I ran the sessions above myself and can answer questions on them. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
