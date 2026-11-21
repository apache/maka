Status: the fix that names this issue has landed, and one claim in my Nov 7 comment below is now outdated on a specific point.

**What changed in magpie.** My Nov 7 reading was that magpie never touches the files in the report's table — that was true then, and v0.1.3559 (15acba534) is deliberately the end of it: while the Codex app is closed, magpie now reads and writes `$CODEX_HOME/.codex-global-state.json` to give every ChatGPT identity the file holds, and every saved login, one shared list of the projects (its commit message names #5497, #5602, #5702, #5874). So an account the app never opened with — what an update's sign-in migration or an account switch lands you on — loads the full list instead of an empty one. v0.1.3600 (10bef5fe0) made the list truly one for all accounts: folders deduped across the ids each account gives them, and a project the user removed on one account remembered (`codex-projects.json`) so it does not resurrect from another. v0.1.3695 (b39a793c9) covers the one case a file can't reach — an app left running across the change: magpie's UI then says the app shows fewer projects than you have and asks for a quit-and-reopen.

**shangdev's "关掉接入codex后恢复正常" is the other landed path** (b3a57b3d8): turning the takeover off restarts the Codex app with its ChatGPT account, and the app loads its own identity's list — which is why the projects return on disconnect with nothing restored by hand.

For everyone on this thread: the loading side was the whole problem. Raters0's recovery (9 projects, 120 re-linked sessions) and the report's own table show the data surviving in the parked snapshot and the database; nothing in it was deleted. On ≥v0.1.3600 (hint from ≥v0.1.3695), quit the Codex app once so the share runs while it is closed, then open it — whichever account it lands on shows the shared list. If something is still missing after that, it would be a new face worth its own report, with the timeline (magpie logs each switch and each share).

The share family is green here today at `f6c882ad7` (`go test ./internal/provider -run TestCodexProjects -count=1`: ok).

Not verified on my side: a real Codex update's sign-in migration on a second account (no second ChatGPT account here); the reports' own forensics cover the data state, and tudou950210-bit's macOS run on #5702 covers the takeover variant of the same parking.

Attribution: AI-written; I've read every line cited and re-ran the tests named. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
