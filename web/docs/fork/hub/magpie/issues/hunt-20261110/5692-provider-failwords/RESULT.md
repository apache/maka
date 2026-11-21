REFRESHED #5692
new head: d175626fda25fc1c500db26551d62f9bc7238943
old head: 939eb732359171315c623714f93b6d152f8530aa
base: ec7a18d12 -> rebase-time tip (zero conflicts across 644-file drift)
sha256[:16]: 8929b0e7215da3e6 (bytes differ from 9aeab3976b3dc80a: line shifts)
Tests green: TestFailWords x6 + 4 neighbors, -race targeted green
Ablation red->restore->green: pitchSaid never-match (2 red as original post)
Sibling: fallback.go +115 upstream, no pitchSaid intersection; reply_spent.go is patch-own file
Design kept: opt-in failWords, no global word list
