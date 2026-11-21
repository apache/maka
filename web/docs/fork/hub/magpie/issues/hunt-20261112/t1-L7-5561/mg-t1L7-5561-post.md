A status note from re-checking this at current main (`9c33839de`), since the test this fix landed with is what I ran into there:

- The fix itself is intact: the card's "This session" line still draws by the conversation's own turns — a re-run of `ctx-session-line.test.cjs` fails only on the points' wording, and the points it actually finds are the lead's five turns alone (96.1K → 108K, no 298K subagent point, no side-call point).
- The wording broke one day after landing: `f418edffc` (Nov 8, "a session's details show how full its context was, request by request") turned the point label into `Request {n}: {tokens} of {window} ({pct})` when the window is known, and the test's two expected arrays (`ctx-session-line.test.cjs:152` and `:163`) still hold the old `… tokens` wording — so the test is red on both engines at current main.
- Updating only those two arrays to the rendered wording greens it again, 4/4, chromium and webkit — everything else the test guards (the subagent's own line, the tool-less side call kept out of the lead's line, the live strip) passes untouched:

```
["Request 1: 96.1K of 512K (19%)", "Request 2: 96.7K of 512K (19%)", "Request 3: 98.9K of 512K (19%)", "Request 4: 106K of 512K (21%)", "Request 5: 108K of 512K (21%)"]
```

@yetone the two strings are yours to drop into the test whenever convenient (I've kept my hands off it — it guards your tree). Nothing in the landed behavior changed; the red is the label, not the line.
