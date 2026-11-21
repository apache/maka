# Comment draft for #2769 (takeover analysis, English, not posted)

Use: one comment on yetone/magpie#2769 confirming the diagnosis and proposing an approach, asking the maintainer how they want the health check to treat distros before a patch is written. No patch is attached: the execution path this change would add (starting the server inside a distro through wsl.exe) cannot be exercised on this machine (macOS), and a patch whose new lines have never run would say more than it has shown.

---

Confirmed on upstream main `5380114d`: the stdio health check runs on the Windows host only, so a server that works for an agent inside a running distro shows as unhealthy (or as `notfound`) in Library.

**Where it is**

`internal/library/mcp_check.go`, `checkStdio` (line 426): the command is started with `proc.Command` in magpie's own environment, in the host home. Nothing in the check path looks at WSL. Meanwhile the server itself is written into the agent's file inside the distro — `internal/library/targets.go`, `wslTargetOf` and `wslOwnFolder` mark the MCP file `WSL: true, Distro: <name>` — where the agent starts it with the distro's PATH and home, and it works. The tag the page shows contradicts what the agent experiences.

**What the check could do**

The pieces are already there:

- `internal/library/mcp_wsl.go` has `wslProbe` (line 74), which runs a script in a distro and refuses one that isn't running (`wslrun.Up`), so a check would never start a stopped distro; `linuxHome` (line 136) gives the distro's `$HOME` spelling for the working directory; `wslExe` handles a command that is a Windows program through interop (that is what magpie's own image server is written as for a WSL agent today).
- `Targets()` maps `Server.Agents` to targets, so the check can know which distros actually have the server (`t.MCP.WSL`/`t.MCP.Distro`) instead of probing every distro.

A shape that follows the reporter's suggestion: run the host check as today; when it fails with `notfound` or `start` (and not `novar`, which says the variable is missing here), and some agent that has the server lives in a running distro, run the same initialize/initialized/tools/list conversation inside that distro — `wsl.exe -d <distro> --exec /bin/sh -c 'cd <home> && exec <command> <args>'`, the server's variables passed along, the health row naming which environment was checked. Cancellation should end what the check started inside the distro, which needs more than closing wsl.exe's stdin.

**Open questions before a patch**

1. Which distro wins when agents in several distros have the server: first running one, one per agent row, or a check per distro?
2. The server's `${NAME}` variables are expanded from magpie's own environment today (`expandAll`); inside the distro the same name often means another value. Pass magpie's expanded values, or leave the variables to the distro's shell?
3. Should the failure text name the environment ("not found on Windows; works in Ubuntu") — that changes `ServerHealth` and the page's wording, and the row would no longer be a plain error?
4. A Windows-only command (an `.exe`) that an agent in WSL starts through interop: should the check try it there too, or only commands the distro has of its own?

**What I checked locally**

On this machine (macOS, no WSL): the call graph above read on `5380114d`; the package's existing checks (`go test -tags nogui ./internal/library -run TestCheck`) pass on main untouched, which only says the host path is as documented here, not that a distro check would behave as proposed. I have not run anything on Windows or inside a distro, and I am not attaching a patch for that reason.

---
**Source**: reported in #2769 (li1how); I verified the named path on upstream main by code audit, not from a failure I hit.

**Red without the fix**: none attached — the proposed behavior change (starting a process inside a distro) can only be constructed here through an injected runner, and the real wsl.exe path could not be exercised at all, so per this repository's standard this is a discussion comment, not a patch.

**Siblings**: `rg -n "checkStdio|CheckServers" internal/library/` → the stdio check, the URL check (remote servers are reached from the host and unaffected), the in-use flow and the sign-in path (HTTP only, unaffected). The gateway's `/mcp/<name>` proxy is host-side and unaffected.

**When the read fails**: unchanged by this comment; a patch would need to say what a distro that stopped mid-check reports.

**Not verified**: anything on Windows, anything inside a WSL distro, the proposed command line itself.

**AI**: written with GLM-5.3-Flash (ZCode). I've read everything cited above and can answer questions on it myself.
