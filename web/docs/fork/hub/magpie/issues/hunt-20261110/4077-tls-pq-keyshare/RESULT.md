REFRESHED #4077
new head: 238488c40da6a120af5e5644672446c8cbb4ed6a
old head: bb436d72b (on f37de8cc4)
base: f37de8cc4 -> 803d7747e (zero conflicts; siblings untouched upstream)
sha256[:16]: 01277af042ae6cd6 (identical bytes)
am: clean checkout 803d7747e, zero-conflict
Tests green: netproxy 4 classical (8.8s, -race 9.8s) + 2 gateway integration (60.6s)
Ablation red->restore->green: TLSHandshakeTimeout dropped + ClassicalRetry unwrapped (5+9-), both red at 45.00s same signature
