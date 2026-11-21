Fixed on main — no patch needed.

`f985d6bdb` ("provider: a Max output kept for a model no longer listed doesn't block the editor's Save") takes the report's exact case — a `modelOutputs` entry for a model the provider no longer lists (`opencode-zen-free/space-bunny-free` from the report, still in settings.json after the model left the plugin's cache) — and stops it from blocking the Save, instead of making the user find and delete the stale value by hand.

Verification on current main: the commit is in the tree (`git tag --contains` → first shipped in **v0.1.1327**); the editor-Save path carries the fix and its guard test.

Version: the report is on v0.1.1325 — one version before the fix. Upgrading to ≥ **v0.1.1327** (current latest is far past it) makes the stale entry inert; nothing to clean by hand.

Thanks @LoKi for the report with the settings.json evidence.

Not verified: the editor Save was not re-driven end to end on this machine (the fix's own guard test and the version evidence stand in).

AI use: analysis performed with AI assistance; the commit and version checks above were run locally.
