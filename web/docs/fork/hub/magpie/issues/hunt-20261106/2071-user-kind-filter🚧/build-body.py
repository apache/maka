import sys

orig_path, patch_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(orig_path, encoding="utf-8") as f:
    lines = f.read().split("\n")
with open(patch_path, encoding="utf-8") as f:
    patch = f.read()

NEW_HEAD = "95d3c4a14cae69d4833e2eeef68589c388ea92c6"
OLD_HEAD = "d290df20880f11b90588d5e8af81600a3d5d0ef3"

reverified = """**Re-verified on upstream/main `2000ae439`, reworked narrower (2026-11-06).** Main moved since this was posted, and it gained the video-models area upstream's own way — `renderVideomakers` beside `renderDrawers`, `filmIds`, ticked to be offered (`HiddenVideomakers`), with `KindModels` already feeding both areas (`customVideomakers`, `Drawers`). The editor's half below is dropped from the follow-up: those areas exist now, and they already list the models the user said make images or videos. What main still lacked was the seating, and the follow-up patch carries just that: `Available()` leaves out the models the user said make images or videos, checked after the ids they are listed by (`ModelKinds` follows a rename, SetModelID); `ExposedOf` builds no unlisted one for a marked pick, the user's word beating the pick; `hasKindable` counts a pick as had whatever its list says. The `MarksKinds` gate and the marks-read-where-they-can-be-taken are as below.

| What | Result |
| --- | --- |
| `TestUserKindLeavesTheChatList`, `TestUserKindBeatsAPick` on `2000ae439`, before the follow-up | red, the same sentences: "Available (the editor's chat chips) still has it: [omni_flash-10s claude-sonnet-4-5]", "Exposed still serves a pick the user said makes videos" |
| Same after | green |
| Ablation: product files back at the parent commit, tests kept | the two red again; green once restored |
| `go test -tags nogui -count=1` of internal/provider, internal/catalog, internal/gateway | ok (the gateway suite whole, 687s, no failure) |
| `go test -tags nogui -run 'ProviderInfo\\|Providers\\|Model'` of internal/gui | ok |
| targeted `-race` of the two list tests | ok |
| `gofmt -l` internal/provider; `go vet -tags nogui` darwin and `GOOS=linux`; `go build -tags nogui ./...` darwin and `GOOS=linux` | all clean |

The branch carries the follow-up, same name, force-pushed: head `95d3c4a14cae69d4833e2eeef68589c388ea92c6`, the patch below applies as is on `2000ae439`. One gap stays with the areas' own work: a marked chip in the image or video areas ticks on and off but has no right-click to say its kind again, so the way back to Auto waits on that (and there is no CLI or API entrance). Not verified against the reporter's relay (no account here): after updating, omni_flash-10s should leave the chat chips, the agents' lists and the gateway's model list at once, keeping its seat in Video models."""

new_subject = "<details><summary>patch: provider: a model the user says makes videos or images leaves the chat list (#2071) — git am applies it as is; SHA-256 first 16: 2ff14408321bff05</summary>"

out = []
i = 0
n = len(lines)
while i < n:
    line = lines[i]
    if i == 8:  # **patch**: branch ... on upstream/main `87d703c5`, applies as is.
        out.append(line.replace("87d703c5", "2000ae439"))
        out.append("")
        out.append(reverified)
    elif line.startswith("<details><summary>patch: ") and "SHA-256 first 16:" in line:
        out.append(new_subject)
    elif line.startswith("```patch"):
        out.append(line)
        # embed byte-exact: drop the patch's last char (a newline) and let
        # the join's "\n" put it back, so the fence content hashes the same
        # as the artifact file
        out.append(patch[:-1] if patch.endswith("\n") else patch)
        # skip original fence content up to and including the closing ```
        i += 1
        while i < n and lines[i].strip() != "```":
            i += 1
        if i < n:
            out.append(lines[i])  # the closing fence
    elif line.startswith("Branch with the commit:") and OLD_HEAD in line:
        out.append(line.replace(OLD_HEAD, NEW_HEAD))
    else:
        out.append(line)
    i += 1

body = "\n".join(out)
with open(out_path, "w", encoding="utf-8") as f:
    f.write(body)

# sanity checks
fences = body.count("```")
print("fences:", fences)
print("has new head:", NEW_HEAD in body)
print("old head gone from head line:", ("(head `" + OLD_HEAD + "`)" not in body))
print("patch bytes:", len(patch.encode("utf-8")))
print("body bytes:", len(body.encode("utf-8")))
print("summary line:", [l for l in out if l.startswith("<details><summary>")][0][:120])
