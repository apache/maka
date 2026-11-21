REFRESHED #3209 (W2C, hunt60-c)
new head: 590b81957b569b045b2517a632e79a690c39093a
old head: b9974989062fef426379b78b3d0e5a6eeb1a7eca
base: 191f3c0af -> rebase-time tip (zero conflicts; web.go untouched upstream, -S webListen empty)
sha256[:16]: 35a249234387e295 (identical bytes)
Tests green: TestWebOnTheGatewaysOwnAddress + TakenOver + NotServedBesideASlowOne
Ablation red->restore->green: webListen reduced to bare net.Listen (1+)
