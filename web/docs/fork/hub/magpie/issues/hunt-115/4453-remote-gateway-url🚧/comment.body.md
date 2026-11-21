Your reading of both sides is right, and I went through magpie's side of it on `main` (`14e351378`) to see whether a patch could safely change what gets written. I think it can, but which value to write is a product decision rather than a bug fix, so I'd rather lay out the machinery and let @yetone pick a shape.

**Where the loopback value comes from.** `desktopOn` (internal/agent/claudedesktop.go) writes `inferenceGatewayBaseUrl: gateway.URL()` unconditionally on every connect. `gateway.URL()` (internal/gateway/gateway.go) turns an unspecified listener (`0.0.0.0` while "Share on local network" is on) into `127.0.0.1` on purpose — same-machine agents are served on loopback by design, and the drift check compares the profile against that same `gateway.URL()`. Sharing never reaches the write: it only widens the listener and requires a gateway key from beyond loopback.

**What already exists around it.** The pieces a fix would ride on are all there. `LANURLs()` is the "address another machine reaches me at" list (MAGPIE_PUBLIC_URL when set, else the pinned MAGPIE_ADDR host, else this machine's private IPv4 addresses first). And the drift checker already tolerates any base URL magpie still answers at: `wiringOff` → `reachesMagpie` probes the address and accepts it (the relay acceptance from #1985). So hand-editing the profile's `inferenceGatewayBaseUrl` to `http://192.168.1.173:3425` is not flagged as changed today, Desktop's local tabs keep working through the machine's own LAN address, and SSH sessions pass Desktop's loopback probe — until a reconnect (provider toggle) or a gateway move rewrites it back to loopback. The import path is stricter: `desktopIsOurGateway` accepts only loopback forms, so a profile exported with a LAN address and re-imported counts as "another gateway configuration". The two paths disagree on what "magpie's address" means, which is part of why I'm not guessing here.

**Why I didn't patch a default.** Writing the LAN address when `lan: true` moves every sharing user's Desktop onto the LAN interface: firewall profiles and DHCP changes would then break all Desktop sessions (nothing watches addresses to rewrite Desktop's profile — the LAN toggle's re-key skips Desktop entirely, since its agent has no per-place gateway address), and a MAGPIE_PUBLIC_URL tunnel would be written into the profile, which hairpin NAT may not answer locally. That default's current shape avoids all of this for people who never use SSH sessions. Your own caveat says the same: an explicit switch rather than a new default. The one place magpie already writes a non-loopback address into agents' configs is the WSL machinery (most recently a1c1b7053), and that came with a reachability probe from inside the consumer's place and a dedicated key — if the default flips, something at least that careful seems right.

| Option | Effect | Risk |
| --- | --- | --- |
| default to `LANURLs()[0]` when `lan: true` | no new UI; SSH works | every sharing user's Desktop rides the LAN interface: firewall profiles, DHCP roam, tunnel URLs via MAGPIE_PUBLIC_URL; the LAN toggle's re-key must learn to rewrite Desktop |
| explicit switch (your lean) | loopback default untouched | a new Settings surface — yours to place and word |
| honor `MAGPIE_PUBLIC_URL` in the profile | opt-in, no UI | couples a share/display knob to agent wiring; not always reachable from the same machine |

**Interim workaround** (from the code, not tried against a real Desktop): with sharing on, set `inferenceGatewayBaseUrl` in the profile to the LAN address. magpie's status keeps showing connected (`reachesMagpie`), local tabs and SSH both work; it reverts on the next reconnect. `MAGPIE_ADDR=<lan-ip>:<port>` also gets a LAN address into the profile, but it pins the whole listener to that interface, so it's the heavier hammer.

**Not verified**: Desktop's `provider_loopback` probe (your read of its bundled JS, taken as reported); the hand-edit workaround against a real Desktop; firewall behavior beyond what a1c1b7053 documents.

@yetone — happy to patch whichever shape you want; the drift-checker side is already free (`reachesMagpie` accepts any address magpie answers at), so the decision is only what `desktopOn` writes and when it rewrites.

---
**Attribution**: written with GLM-5.3-Flash (ZCode).
