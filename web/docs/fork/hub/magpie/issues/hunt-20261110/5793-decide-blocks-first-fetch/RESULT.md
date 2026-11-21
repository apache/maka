REFRESHED #5793
new head: 7c347da7338154a79dacb0716a17982e44971650
old head: 3078acad43111693d441c31bd71c3460acbbccaf
base: fdd38154b -> 7e5cebb86 (zero conflicts)
sha256[:16]: e8bdd3176108aa02 (bytes identical to original post)
am check: clean checkout of 7e5cebb86, git am zero-conflict -> f05d83a80
comment: https://github.com/yetone/magpie/issues/5793#issuecomment-6745852345
created_at(UTC+8): read via gh after post
Tests green: TestPluginDecideFetchAsksTheListFirst, TestPluginDecideTestLeavesNoDecideRowWithoutModels, TestPluginDecideFetchBeforeItsFirstList (bun PASS -v), TestProviderTestAsksAnAccountThatServesItsModel
Ablation red->restore->green: fetchList arm removal (models.go, -3 lines), test.go !p.IsPlugin() drop (1+1-)
Sibling: fdd38154b..7e5cebb86 = 6 commits, none touches models.go/test.go/decide.go/fake index.js
