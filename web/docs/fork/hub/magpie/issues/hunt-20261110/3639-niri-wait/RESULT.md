REFRESHED #3639 (W2C, hunt87-la)
new head: af007c6555cc9eceee3f0d6e3cdeb182fb9f4c90
old head: f88412b92d1f85fbee6ef5c7494603606ff2aeb9
base: 191f3c0af -> rebase-time tip (zero conflicts; omarchy untouched upstream)
sha256[:16]: 5f51233a4f690d9e (identical bytes)
Tests green: TestPlacePanel + NoOutput + TestWatchWindowsRefused (6.9s), -race green
Ablation red->restore->green: raise dropped to production second w/ 1.1s sleep (issue recipe), 2 tests red as reported
