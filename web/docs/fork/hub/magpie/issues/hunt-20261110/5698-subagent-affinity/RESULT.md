REFRESHED #5698
new head: de843a3f0cabdd3c17841efad65df9a9e4a6211c
old head: 2ffaf34fd78b50f8605b320e212581a39a5b9256
base: aa3d11d5b -> rebase-time tip (zero conflicts across 131-commit drift; am clean on newest tip e9b8b1c83)
sha256[:16]: 40c747d1d46e850b (bytes differ from e69b734768ef6748: line shifts)
Tests green: TestCodexSubagentsKeepTheirOwnAccounts (rotate+smart), TestCodexChatWithoutSubagentsKeepsItsAffinity
Ablation red->restore->green: |thread: branch out of stickKey (-5, |agent: untouched)
Sibling: upstream drift = backToFirst accounts + cacheHolds + strictKeep caps, stickKey untouched
|thread: design preserved
