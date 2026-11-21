The exact thing you're asking for already exists for Codex, and the duplication you see is the designed shape for the other agents:

- **Codex** has a three-way switch for how magpie connects to it, and its third position is precisely this: "magpie is Codex's provider, with magpie's models only" — the Codex app then lists only magpie's models while keeping its ChatGPT account for chats and projects. The default position is "magpie's models join Codex's own", which is the join that duplicates.
- **Other agents** are joined by design: "{agent} is connected to magpie · it stays on its own last pick; magpie's models join its {cmd}" — the agent keeps its native models beside magpie's, so its own account and models keep working when magpie is off (the joined lists are built per agent in internal/agent/route.go). Extending a "magpie's models only" position to agents beyond Codex is a feature ask for the maintainer; no provider-side setting changes it today.
- What you can scope from magpie's side right now: a provider's model list in the editor (Select all / Select none / the filter) decides which magpie models appear in the agent at all — narrowing it trims magpie's half of the join, though the agent's own models stay.

Which agent are you applying? If it's Codex, the mode switch is already there in its row's settings.
