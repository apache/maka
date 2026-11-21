REFRESHED #3844
new head: 7c7862fc8459c26bf103b3ed72c216b0c19b7f73
old head: 870037c2e54ac221f32c3b3b0ae4e8ee708b6384
base: f37de8cc4 -> 803d7747e (zero conflicts; test.go untouched upstream since f37de8cc4)
sha256[:16]: f125b4ca31ff5b20 (bytes differ from 6aed398e347a5047: hunk line shifts; semantics unchanged)
am: clean checkout 803d7747e, zero-conflict
Tests green: TestTestTriesTheNextModelOnTheEndpoint + TestTestModels*/TestTestUsesEachEndpointsKey/TestModelTest/TestTestAs*
Ablation red->restore->green: next-model walk removed from Test probe loop (1+16-)
