Diagnosed — nothing picks free models behind your back, and the worst of what you saw was a bug that was fixed the day before you filed this. Updating magpie is the fix.

**What your screenshots show**

"Our Free Model" is a plugin provider: its model list comes from the plugin's service, and that list churns — free pools go down and come back, and the list stays short for a while after its service starts. The models you had picked (the deepseek / glm / minimax pools in your third screenshot) are exactly those kinds of pool, so they come and go with it.

**Why your picks vanished**

Since v0.1.1167 the magpie serving the gateway re-asks the plugin for its list every hour, and a picked model the new list doesn't have leaves the picks (`internal/provider/plugin_relist.go`, `dropGonePicks` in `internal/provider/models.go`). On the build you were on (v0.1.1167 – v0.1.1293) such a pick was dropped for good, and with no picks left magpie served the vendor's whole list at once — the head of Our Free Model's list is all free pools. The dashed chips in your first screenshot are exactly that served list: not a selection magpie made, just the models agents get while none are picked. That is the automatic free-model selection you saw.

**What current builds do instead**

- v0.1.1294 (2026-10-19, the day before this issue): a pick the list drops is set aside, not forgotten. While any pick is set aside, none of the provider's models are served — for up to an hour — and the pick comes back by itself once the plugin lists it again, usually within minutes (the loop re-asks every 5 minutes after a drop).
- v0.1.2768 (2026-11-03): only after a pick has been set aside for over an hour does magpie serve the vendor's list again; set-aside picks still return when the list has them.

So on v0.1.2993 (current): your picks may still disappear for a while when a pool is down, but nothing is served in their place for the first hour, they return on their own, and only a model the plugin takes off for good needs re-picking.

**If it still misbehaves on the latest build**

One gap remains on current builds, for the maintainer's attention: while picks are set aside the editor shows nothing ticked and no word that they are set aside, which reads exactly like this report. And if, on ≥ v0.1.2768, your picks disappear and never come back while the models are still in the vendor's list, please post your magpie version and the `our-free-model` entry of providers.json (its `models` and `delisted`) — that would mean the plugin renames its pool ids between restarts, which magpie cannot follow, and would be a bug worth its own issue.

**Credits**

Thanks @Sun1090 for the report and the screenshots — the picked-versus-dashed pair made the mechanism easy to pin down.

Attribution: written by AI (GLM via ZCode) as ggbdpq; verified against upstream/main at f24829636af07d270ae902d132dbe5f76563629f.
