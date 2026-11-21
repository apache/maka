The reporter's fix branch covers this — verified it locally, and it applies cleanly on current main.

Mechanism, checked against the diff (commit `14343ce5`, `codex/issue-2961-launchd-process-type`)
---

| claim in the branch | in the diff | result |
| --- | --- | --- |
| only `ProcessType` changes | `internal/daemon/launchd.go`: `Background` → `Standard`, plus the comment saying the gateway is on the request path | PASS |
| a regression test pins it | `TestLaunchdPlistProcessType` in `internal/daemon/daemon_test.go`: requires `Standard`, rejects `Background` | PASS |
| boundary: install/uninstall/reload untouched | no other hunk in the diff | PASS |

Verification
---

| check | result |
| --- | --- |
| its test on the parent code | RED — `the plist says "<key>ProcessType</key><string>Background</string>"` (matches the reproduction comment word for word) |
| its test on the fix | PASS (`TestLaunchdPlistProcessType`, `TestLaunchdInstall`) |
| ablation | switching the one value back to `Background` turns `TestLaunchdPlistProcessType` red again |
| am gate | `git am -3` of its format-patch onto a clean tree at current `upstream/main` (`759b4d1d7`) applies as is |
| plutil on macOS | a plist with `ProcessType` `Standard` passes `plutil -lint` |
| gofmt | clean (`tr -d '\r'` judgement) |

`Standard` over `Interactive` is the right call on this evidence: it lifts the launchd throttle without jumping the queue the way `Interactive` can, and it matches the reporter's own A/B (daemon slow, tray `Interactive` fast, same machine).

Existing installs need `magpie daemon install` once more to pick it up.

Branch with the commit: Edward4226/magpie codex/issue-2961-launchd-process-type (head 14343ce5c062bdd38f24088a145181e2a34bfe56)

Not verified: a real launchd reload and a performance A/B on this machine (no daemon was installed here); Intel Mac scheduling and low-power mode behavior.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.

Thanks @ZzZ-hu for the report and the controlled A/B, and @Edward4226 for the fix branch.
