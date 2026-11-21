REFRESHED #5805
new head: 6e32ed554a5ed9f7b283b1c974e015ce0242268b
old head: a768f269fa1dc11ca152de4deed71d386d38ee25
base: be9dbce02 -> 803d7747e (zero conflicts; tip moved past 7e5cebb86 mid-run)
sha256[:16]: 94dc4b916ef75137 (bytes differ from 9f1cffc62aef5039: upstream insertions shifted hunk line numbers; semantics unchanged)
am: clean checkout 803d7747e, zero-conflict
comment: https://github.com/yetone/magpie/issues/5805#issuecomment-6746199281
Tests green: MiniMax 5 + Grok/DashScope 3
Ablation red->restore->green: relay-chain hunk removed (gateway.go -3 lines), both subtests red
Sibling: chat.go untouched upstream; gateway.go changes = groupGiven + timedHeld, no intersection
