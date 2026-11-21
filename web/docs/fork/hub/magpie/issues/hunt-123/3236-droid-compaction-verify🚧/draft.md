The reporter's fork patch covers #3236; I checked the relevant changes independently and it applies cleanly onto current main.

The diff is scoped to Droid's model-writing path: `internal/agent/droid.go` now writes each model's effective `Compact at` as `compactionTokenLimitPerModel` alongside `maxContextLimit`, keeping the compact threshold no greater than the model window. `internal/agent/stash.go` tracks the values Magpie owns so sync/reset updates or removes only unchanged Magpie-managed entries and leaves manual Droid edits alone. It also handles connected-model sync, removed models, and disconnect. The patch does not touch unrelated agent adapters.

The branch's tests and ownership logic need a full verification pass before I can call it ready; the quota interruption stopped that work before the required test matrix and post were complete. I have not published an endorsement or patch for it.

Not verified: the full agent package, the exact e17b6cefc-to-current-tip three-way application, and a live Droid settings sync. The draft and evidence are saved under `/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-123/3236-droid-compaction-verify🚧/`.

AI use: analysis performed with AI assistance; the files and branch history were checked locally.