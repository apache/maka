The entry isn't missing by accident: in gateway mode — which is what `magpie web --lan` serves — the provider editor deliberately shows none of the warm-up / resets / check-in lists. Answers to your three questions, from main (`f6c882ad7`), all present in your 0.1.3758 as well:

1. **Where it lives**: in the desktop app, a subscription's warm-up / resets / check-in lists are the provider editor's own fields under Advanced (`PROV_PREFS` — codex: "Resets" + "Warm up", claude: "Claude Code" + "Warm up", workbuddy/trae/minimax/qoder: their check-in lists). The v0.1.3371 changelog's "migrated to the provider editor" describes the desktop editor.
2. **Type-conditional**: yes — per agent; each agent's editor mounts only its own lists.
3. **Web vs desktop**: they differ on purpose. `gatewayMode = web && bootPrefs.gateway` (set when the process serves a gateway's page, api.go's boot handler) filters the lists down to `claudeRunList` only, and `provPrefsField` returns nothing at all for non-claude agents in gateway mode (app.js:19655/19684-19686 — the same lines are in v0.1.3758, app.js:19656/19685). So on your Docker page the Codex "Warm up", "Resets" and the Claude "Warm up on reset" rows are hidden, not misplaced.

The hiding is coherent rather than an oversight: the warm-up's requests are sent through the local apps ("Sent through Claude Code"), and a headless Docker server has neither the Codex app nor Claude Code to send them through. Whether web mode should grow its own way to configure — or run — warm-ups is a feature ask for the maintainer; filing it as one would be the right next step.

Not verified: your exact build beyond the v0.1.3758 tag check above; a real Docker deployment on my side.
