Triage against the code — none of the three observations matches what the routing page's source does, at your version or at today's:

**"Several accounts or keys" — its buttons were never deleted.** The section is drawn by `renderPools` in `plugins/routing/client.js`, and that function is byte-identical at `v0.1.2767` (lines 7501–7534) and at today's main (lines 8844–8877, `e2afa3931`, 1,607 commits later): it builds the heading and every provider's row — each with its Routing / Stays / Rate limited controls — in the same pass, and hides the whole section when no provider routes over several accounts or keys:

```js
pHead.hidden = pList.hidden = !ps.length;
pHead.replaceChildren(...);           // the heading you still see
pList.replaceChildren(...ps.map(...)); // the rows and their buttons
```

So "the heading with no buttons under it" cannot come from a removal: the only code path that shows the heading without rows is an exception thrown between those two statements, which would also leave errors in the console. Across `v0.1.2767..main` the nearest changes to this section are a performance fix (7a2a05c7a, icon reloads) and the settings reorganization (a6e4cf763, what routing does moved under Models › Routing) — nothing removes the controls. If a current build still shows the heading empty for you, a screenshot plus the console output would pin the actual failure; from the code alone it is not reachable.

**"Text residue" under Find groups on their own — upstream already folded that.** What sat there was the card's long always-visible explanation. On 11-10 (cec267f90, answering another user's "the descriptions are too busy" complaint) the Routing cards' long explanations — this one included — moved under hover/focus, the same way Settings' rows have worked since 11-02 (8e9b048b6, the same day as your version). On a current build that line is out of sight until asked for.

**Custom names without the `group/` prefix or the lowercase rule** — that is a design decision, not a defect: groups found on their own are deliberately namespaced `auto/…` (the toggle's own copy says so), and the lowercasing comes with it. That is @yetone's to accept or refuse; if you'd like it, it is worth its own issue saying what you'd name groups and what should happen when a custom name collides with a model id.

The report is six days and 1,607 commits old (0.1.2767 → v0.1.3906); both page areas were reworked in between, so re-checking on a current build is the first step either way.

*Written with GLM-5.3-Flash (ZCode); claims above are file reads at `v0.1.2767` and `e2afa3931`, checkable with `git show`. Not run: the GUI itself (no reproduction to drive).*
