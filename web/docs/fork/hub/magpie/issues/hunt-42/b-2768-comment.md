Read at upstream/main `5380114d`. Your reading of the code is right, and
you clearly hold working local fixes already, so this is only for the
record — a PR from you would be the faster way to land this.

What the report names, at that tree:

- `vscodeURL` (`internal/agent/vscode.go:405`) is `gatewayV1() +
  "/chat/completions"` — the loopback endpoint — and `vscodeGroupJSON`
  (`:410`) writes it into every model entry's `url`, with the key picked by
  `k.token()` (`:429`, `:436`), which has no WSL-side context either. The
  generated `chatLanguageModels.json` therefore points a WSL extension host
  at an address NAT doesn't route, and at a key accepted for loopback
  access, not for the non-loopback path the host would have to take.
- WSL discovery dropping a distro found only through its `.vscode-server`
  directory is in the same area and would leave such a setup undiscovered
  even with the address right.

The shape that would close it: a reachable endpoint for an extension host
on WSL (the host's LAN/sharing address when sharing is on, as the MCP relay
did for the same NAT setup in 91581fca, #1488) paired with a key accepted
for non-loopback access, used consistently by the connect, model list,
Check and key-rotation paths and by registered profiles. Which address to
prefer, and what to do when sharing is off, is a design choice for the
maintainer; the reporter's local regression tests (Stable, Insiders,
profiles, sync, model selection, rotation) look like the right base to
build that on.

Written with GLM-5.3-Flash (ZCode); I've re-read the cited code and can
answer questions on it.
