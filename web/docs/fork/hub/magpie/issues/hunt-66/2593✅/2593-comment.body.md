Confirmed on a real machine: magpie **0.1.1327** (which carries 240f3eb4c, shipped in v0.1.1322) resolves this end to end behind Clash TUN on Windows.

**Environment**: Windows 10 22H2; Clash Verge 2.5.8 / mihomo v1.19.32, **TUN mode on** (gvisor stack, `dns-hijack: any:53`, fake-ip `198.18.0.1/16` — with TUN up, `example.com` resolved locally to `198.18.0.20`). Magpie itself had no proxy configured, so the fetch dialled the fake-IP direct and the TUN carried it — the pure-TUN shape @TomXPRIME reported. (The Windows system proxy was separately on at `127.0.0.1:7897` throughout; it does not intercept magpie's own dials.)

**Probes** — through the gateway's MCP servers (`POST /mcp/magpie/web-search`, `POST /mcp/magpie/vision`), i.e. the same tools the models get, after verifying the DNS answer was fake-IP:
| Check | Result |
| --- | --- |
| `web_fetch https://example.com` | page returned (`Title: Example Domain` + body) — the exact step that used to die with "it is at a private address … which web_fetch doesn't read" |
| image download over https (vision tool fetching an https image URL) | image fetched and described correctly |
| negative control: `web_fetch http://127.0.0.1:3425/v1/models` | still refused: "it is at a private address (this computer, its network, or a name that resolves to one)" — the guard's refusals did not loosen |

TUN was switched back off after the probes; nothing else on the machine was changed. The loopback-explicit-proxy shape @h4rk8s reported keeps its own narrower branch and tests — this run covered the no-proxy TUN path.

Thanks @yetone — works on Windows + Clash TUN now.

Probes designed and run with an AI coding agent (GLM-5.3-Flash / ZCode) under my direction; probe outputs above are verbatim.
