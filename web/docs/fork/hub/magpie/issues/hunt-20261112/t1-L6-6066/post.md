Short answer: reset-card auto-use is Codex-only in magpie, and there is no Claude hook for it because Claude's limits reset on their own schedule.

- The auto-use machinery reads OpenAI's reset credits (the "reset cards"): `codex_autoreset.go` (the week-used-up card, one a week) and `codex_expiring.go` (the about-to-expire card). There is no Claude counterpart — the reset-credit reading and the auto-spend exist only in the codex files.
- What Claude does have is **"Warm up on reset"（窗口重置时预热）**: settings → Warm-up and check-in, or a Claude provider's "Warm up" in the desktop editor — `claudeWarmup` in the settings, sent through Claude Code. If what you want is "don't waste the start of a fresh window", that switch is the existing shape of it.
- If Anthropic's card offer exposes something an integration could read and spend, that would be a feature ask for the maintainer — nothing in main reads anything like it for Claude today.
