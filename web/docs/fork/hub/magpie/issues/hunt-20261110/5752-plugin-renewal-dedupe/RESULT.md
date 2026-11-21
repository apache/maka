REFRESHED #5752
new head: 155f8311167991c9a8166230fe6d3b343e60d20a
old head: 86cd26f1314edeec34b9bdd033b5b59656aade01
base: a6e4cf763 -> 7e5cebb86 (zero conflicts)
sha256[:16]: ef20c9490fd28e75 (identical bytes)
am: clean checkout 7e5cebb86, zero-conflict
comment: https://github.com/yetone/magpie/issues/5752#issuecomment-6746080241
Tests green: TestRenewalStillDueBacksOff (-race, -v PASS not SKIP), Renew|KeepSignedIn|Keep|KeepAlive family plugin+provider
Ablation red->restore->green: still-due early return hunk removed from renewLocked host.js (-5 lines)
Sibling: a6e4cf763..7e5cebb86 plugin/ touched only by 623e797fd (page.go/usageapi), host.js untouched
Credit kept: Reported-by: hanxuanliang
