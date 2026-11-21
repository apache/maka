@TomXPRIME Thanks for the Windows + Clash Verge Rev repro — and your reading of the patch is exactly right: `fakeIPProxy` required a proxy on this computer, so pure TUN with no `HTTPS_PROXY`/system proxy was still refused. That case is now covered on main, no new patch needed: yetone took both patches and landed `240f3eb4c`, which fetches a name whose every answer is in `198.18.0.0/15` either way:

- through a proxy on this computer, the proxy is given the **name**, not the fake address (h4rk8s's Surge comparison showed CONNECT by name succeeds where CONNECT by the pinned fake-IP fails);
- with **no proxy (your pure-TUN case)**, magpie dials the fake address directly and the dial guard lets exactly that address in — the TUN carries it to the host the name stands for, as you described.

Everything else stays refused: an address literal in the range, a mixed answer, a proxy on another machine, and the usual loopback/private/CGNAT ranges; redirects are re-checked as before. The rule now lives in one shared place (`internal/netguard`), which the icon fetch uses too.

On the PR: this repository doesn't take pull requests from non-maintainers (README, Community section), so fixes from outside go as a fork branch + a `git am` patch, which keeps authorship — that's why the fixes were posted in that shape. Here it's moot anyway: the commit is on main with the `Co-authored-by` line kept.

Timing: the fix missed `v0.1.1321` (the tag was cut minutes before it landed), so it ships in the next release. Once it's out, a `web_fetch` check from your Windows + Clash Verge Rev setup is exactly the confirmation the issue is being kept open for.
