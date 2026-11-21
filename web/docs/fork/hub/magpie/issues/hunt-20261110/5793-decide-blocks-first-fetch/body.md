Rebased onto current main `7e5cebb86c92` (2026-11-10 00:36 +0800). Zero conflicts — the patch applied as is on the new base.

Tests re-run on the new base: TestPluginDecideFetchAsksTheListFirst, TestPluginDecideTestLeavesNoDecideRowWithoutModels, TestPluginDecideFetchBeforeItsFirstList (through the plugin's host, bun on PATH, `-v` confirms PASS not SKIP), plus TestProviderTestAsksAnAccountThatServesItsModel (the caller's provider value pinned last time) — all green.

Ablation re-done on the new base, both points:
- `fetchList` (internal/provider/models.go): the account-list-first arm removed back to the old decide-first order (`git diff --stat`: 1 file, 3 deletions) → TestPluginDecideFetchAsksTheListFirst red ("the plugin's account list was never asked") → restored → green.
- `Test` (internal/provider/test.go): the early return's `!p.IsPlugin()` dropped (`git diff --stat`: 1 file, 1 insertion, 1 deletion) → TestPluginDecideTestLeavesNoDecideRowWithoutModels red ("the decide row came back") → restored → all three green.

Sibling scan vs `fdd38154b..7e5cebb86`: 6 upstream commits landed, none of them touches the sibling files of this change (internal/provider/models.go, test.go, decide.go, internal/plugin/testdata/fake/index.js) — every point of the original scan's rulings stands as written; re-verified the rebased `fetchList` carries the account-list-first arm intact.

Fresh patch: `git am` ready, applied on a clean checkout of upstream/main with zero conflicts, sha256[:16]=`e8bdd3176108aa02` (unchanged from the original post — the patch bytes are identical); branch: https://github.com/ggbdpq/magpie/tree/fix/5793-decide-blocks-first-fetch (7c347da7338154a79dacb0716a17982e44971650).

Generated-by: GLM-5.3-Flash (ZCode)
