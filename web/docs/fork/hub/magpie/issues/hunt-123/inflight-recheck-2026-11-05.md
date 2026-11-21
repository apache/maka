# hunt-123 在案单漂移复审（2026-11-05，116 支）

> 冻结 tip `2488532257daeb79605567d44898925bf47942f2`（2026-11-05 14:19:28 +0800）；漂移基准 `83137bcbe`（今审计快照）/ `dabb5722f`（rework rebase 目标）。口径：八要素证据以 `journal/audit-2026-11-05.md`（104 PASS / 2 返工）为准，本轮只判相对 tip 的漂移——LANLED 全量排查、fork 全分支 fetch、merge-tree 无 worktree 冲突判定、format-patch sha256 复算、触面与 `83137bcbe..2488532257` 漂移文件交集决定证据 REUSED/RERUN。

## 总表

| 单号 | 形态 | fork分支 | fix全SHA | merge-tree | 冲突文件 | sha256full（raw / 去签名） | 证据 | 四态 | 动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #2935 | patch（测试稳化） | fix/2935-agent-expand-steady | 360e436abf431517c7994a99fb64db0edd1a938d | AM-OK | — | ebabb30b6726cca5366446ea928a3b782f7815aa6644468746e938c711ae24ec / 去签名 148e242a114eba32d1c0ee478048d356abfd1f02e65afe034773604f6e81197f | REUSED | **READY** | 证据沿用 11-05 审计 |
| #2945 | patch | fix/2945-upstream-hammer | 1e1039549b647db39c5cbc25939737170deca876 | AM-OK | — | c1b7a9fc141bd8255afeaf1d2da88977b40c209db0f4f4c8f7f934a0ef262b44 / 去签名 ed9b5b88596a4a677df8058b0b9d1e5fe6989149ad14e7d74db3e7e5865563e0 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #2950 | patch（测试稳化） | fix/2950-sidebar-anim-sampling | f7ee701492a240181d174fab68e8aa8c37048757 | AM-OK | — | 75d86b52b6a12a8b4847e5e8a30928580d5f5a5df136b11784e88a3f983e757b / 去签名 6e0f5cdc1bf355113d914439f6b3624b3e327a14a33c92fe4f029056357c84c9 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #2961 | 验证帖（让位背书，Edward4226） | Edward4226 codex/issue-2961-launchd-process-type @14343ce5c（第三方 fork，无分支可 am） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #2965 | patch（测试稳化 rework） | fix/2965-providers-once-load | 76f8fd7fb64f952f49fd6f4454582a88ea1f0568 | AM-OK | — | 8c9c64bb97984320ca06cf7227067b634a24ae33f3d48a63280300ed7a387191 / 去签名 1a3f3cad08cb523183644f6c18c9ebd7025b8c7e8c7b9a02ad7115777b8ef91d | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #2982 | patch（测试稳化） | fix/2982-tempdir-cleanup | 3f6b58b26f517c653e29001bbe81456948bfc5a7 | AM-OK | — | 43094ecfcd07cd16276b6040589fc0e3310677fea683bc948764cd1349525672 / 去签名 91e586e54fd0327db9826d0c5c301b7fd1dee3c59d20e9f45b11143791f58373 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #2990 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3000 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3012 | patch（部分已 landed 判定） | fix/3012-kimi-usage-empty | 45b47844681c05c0083b7b34199f21e61e7f6fd4 | AM-OK | — | 0ff78d505e6046ec9be341d340d508286d4196b6be4743b04a2cabf3638c0b2a / 去签名 ee2f7d0ce126b2e483355ad4d23478f6beb6c6dab5abc1cb2cd58907b80b43c8 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #3042 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3078 | patch（测试稳化） | fix/3078-lightweight-test | 03d2c9d49762eedab255289f5e8b4df81ce65853 | AM-OK | — | fa3d64357ab5ef2b27dc6e522410f01abcb613fb720ec334c851be7baa2d3d57 / 去签名 c22a81971a8977af6063a5db7b7997aacc4f4a293eafae81112e0a1e41412776 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #3106 | patch（recovery 面） | fix/3106-compaction-silent-assistant | cbf216af738ef5f275bb9298e301705401026509 | AM-OK | — | 93fd8c99068f2f09b5c147b672522ea5f80cc528ecd84e96f85225ee4a602e4c / 去签名 4f0cb65351a643d9df3fd224be336de0a9426025b7574a6ac6dcc30d494c276c | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #3160 | 判定帖（已 landed） | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 09c0a844bd0719f7a44df2ab83bc96aea333040d |
| #3187 | patch | fix/3187-balance-url-import | d64ff2d468dd740ccf10f15217d88330c1db6b52 | AM-OK | — | e04ab2f1ba8184bc1e30de3e79b1122a6b41ef739b51b5cbaa58dce228858032 / 去签名 6f4d4bb74691b16592cd6603d3af5ff8a9d479f79140c28c03c8db8883e740df | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #3208 | 验证帖（让位背书落地） | fix/3208-go-xnet-bump | 41fe4e356d223fc6fdb8f1f668ed9651848d3a23 | AM-OK | — | ce7cc96666c9772724d5c4ecf33b8a9ceaba1673c395e1acad7714aeea1e4523 / 去签名 0f833fe4cf49ff8a1f26c589aa7343deb4030f94baea49a3d90fd0680fac8a34 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #3213 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3305 | 已 landed 判定帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 f985d6bdb68ed9359b35124f98b1fac5085886b3 |
| #3566 | 验证帖（FAIL 判定，skygunner） | skygunner fix/3566-kimi-typed-ref-untyped-union @df5363d0（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3615 | 验证帖（让位背书，skygunner） | skygunner fix/3615-loop-guard-does-not-cover @125a5e087（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3616 | 已 landed 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3619 | 验证帖（FAIL 判定，skygunner） | skygunner fix/3619-model-scoped-rate-limit（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3684 | 验证帖（FAIL 判定，skygunner） | skygunner fix/r25-empty-tool-calls-finish @91625dca0（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3690 | 验证帖（让位背书，skygunner） | skygunner fix/3690-claude-room-freed @56b4f3174（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3695 | 已 landed 判定帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 430e3050d86a6ec2e2c10b3ed1ad8ab78eaa7ece |
| #3696 | 已 landed 判定帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 5f3146be09557a0a7ed2726631698e76b0320548 |
| #3700 | patch | fix/3700-reopen-app-alone | 90d8baffa07fe01c107bfa11b0c47813ff7cbd97 | AM-OK | — | 3519ef0ec33c3e6f9b6065dd399eb0e8254c12f8110030ad1f400ffbec9c51e7 / 去签名 6e646c3ebf52ecf1118365b8a7a02b3f1bbcb6bb81b9eaf6e8374fdc86c25bd3 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #3704 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3761 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3844 | patch | fix/3844-endpoint-next-model | 0f5273a8557a7d0f96db484e0a1438c1bb6198f8 | AM-OK | — | b5e90247775846982308033677a0cd48825d659fdd7e3c6acb5837c947c52d3f / 去签名 66e738acd8e78918350037ca0171e341968f6e50f1a406abe27ad633b88a7443 | REUSED | **READY** | 证据沿用 11-05 审计 |

## 总表（续 1）

| 单号 | 形态 | fork分支 | fix全SHA | merge-tree | 冲突文件 | sha256full（raw / 去签名） | 证据 | 四态 | 动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #3849 | 验证帖（让位背书，skygunner） | skygunner fix/3849-codex-compaction-custom-tool-call @3befa94ee（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #3866 | patch | fix/3866-codex-baseurl-uninstall | d7affd027e00dc84f8d0a5bde4d28cdb7a6c00a9 | AM-OK | — | 742f6064d116e98aab51e8e51448b62493ae6f531dc2651551f5b36f8658663f / 去签名 5d6415ebce4a8c257d779bfc8755197d2b832e631f24c65c6b86716dd04dd4f2 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #3890 | 已 landed 判定帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 f8cd964aec7630534c3c7b14bdbed75223eb9c32 |
| #3936 | patch | fix/3936-gemini-image-size | f3afe1720f1d7ff7535178be14fd3300aaa8d234 | AM-OK | — | e6742b6300c6e419035c6fbe68f38cbd6507761ab1f8a3297ed3e6a333dcfb90 / 去签名 be8dec8392e7fc15551b957260ef43ac261851f1268ab7687b20ac4e90a7139f | REUSED | **READY** | 证据沿用 11-05 审计 |
| #3937 | patch | fix/3937-gemini-genconfig | 6df21df128b0ecd4b5d1960712542c57458b9423 | AM-OK | — | f61a7a060880ab8c7ada2febc2bc0705d6bc6f0bb55dd41ab07c1dda3d224edf / 去签名 c3a73503e31ed1267a14de55a072a875f7cc2acc33f6920070a7e6de35bfdae8 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #3967 | patch（rework 后） | fix/3967-billing-200 | 2c1fdc904190f8431384e8223eaf64b05668ceaa | AM-OK | — | bc3a5e25de7ae1029075a6c7c2ca1cc5b9077d8b8de86bc1a9857768d22827fc / 去签名 06664d721fb19e97c789977cc59cb38993770a849b6d4ca80c786243110aefbe | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4030 | patch | fix/4030-keep-through-rest2 | c233b744cc3eacd85bef4fa5159d39552e22a743 | AM-OK | — | 2a51f518e77e2d7987f32aa2f966a3ce99c4f4082ad608bd41c8db898cfaee7b / 去签名 2291bb89fcbd7e22972209faa80c7c131c75a53cd173e8116a48f74d0eb63898 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4034 | 验证帖（让位背书，verify 分支落地） | fix/4034-ultrafast-tier-verify | cf4f17dc47b8c9cb4d803711b4859234e0c8c88b | AM-OK | — | 7ca651c32ba3379f756f135bf205357315d1733bcc345796d239010d5c15af42 / 去签名 ea754272ea93745ebf1852e1b4df2d3da6e0b8e177a5d8abff5f48d22ff33197 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4040 | patch | fix/4040-codex-400-context | c935d0252a7b105473206b89ee3c6244b87396a9 | AM-OK | — | c8015ffac5007fc52da0fbe40b78931248e68c26103041b0e3f0c36543c4f4e2 / 去签名 2f45a56471c48af1dd8072d59825619e761f4e04a45bc5e532919de672b918e5 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4056 | patch | fix/4056-key-protocol-fallback | 1a959e8b1f630b833c456dd305fca984cc0e3a1c | AM-OK | — | a25672c40b5e53d9582b710d1b126a6e7a0ea1a49bbeb4349fb2a771c85e0ae3 / 去签名 f0590e08d69c642cb31c597dff1098c1cbd4947a0457d912298045d5cab28d18 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4069 | patch（叠 4166 分支） | fix/4166-thinking-stream-group | f10443d26abaeec2686f66eb0d458b5d33be8b35 | AM-OK | — | 2dda20be931aa9db9406d6c13bde380ef1efed79624def0488fd07c1da28b517 / 去签名 eeb9e0a0b470eb47a1bb3d7b32b6366f3232da45356bd7f30023ea74986f41f6 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4077 | patch | fix/4077-tls-pq-keyshare | 9af2fdb998d08a425c02442799973ca5d5e0cbbd | AM-OK | — | 38ddba35670890f661b7b2000e4ed1ba25de27005a1950425bdd893917ce0e2e / 去签名 be7cfd129a9d9bce7b68e2824182ce1ef6dc27e3b00ec555d195d29fcf58b295 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4087 | patch | fix/4087-redact-node-modules | b9b79150c2d728062a185db5b49b070b5a1fb81a | AM-OK | — | f78a063b1872c90584b1db4a7d338abcd094638ad247dc9943ce122f20c28bda / 去签名 90d95982e346552c4380352a5b628178bb49178d9a98513bf9d5d0955ec2940b | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4108 | 验证帖（让位背书，verify 分支落地） | fix/4108-agent-message-verify | e1aabd98f0c067de84f45ed306b8743d0fb3414e | CONFLICT | internal/gateway/codex_backend.go | 2bef46ba6022162ccdf63353c354350b229c88eaef501c6426d4998a71723777 / 去签名 ee8bebd0d02e743c8c9c9ff6cc11632e2f83178cda5677e1616fb94e2fe59942 | — | **REWORK** | 作者 rebase：codex_backend.go 内容冲突（tip 新落 #3183/#4910 同文件区） |
| #4148 | 验证帖（让位背书+新面披露，verify 分支） | fix/4148-compact-at-min-verify | a4478a80ea8a5b3b77d4aa4627c7556745ce8355 | AM-OK | — | 55d2c42a9ccfcab6bb2c4331b0203e54160d994aec2d493e2a4e059c90780f93 / 去签名 4b6e32478bcbd2cab4e49d640eb0c62b4503d8a56ca87afdf0dfd08ddd3ca710 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4150 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4165 | 已修复出列帖+测试入仓（test-only patch） | fix/4165-passthrough-thinking | 709d2456d20a887c6be4a8968b61e9cd8fdc6695 | AM-OK | — | 374e59cbe3de6422f711082b3e753f0455c7719cc35fb05f218c01d9778e48a8 / 去签名 28d69479f414433c0259dbc8a53f9363df76b41e1597e2257f5b62b7668935d2 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4166 | 判定帖+原型/回退对 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 0a5dc40abc4fca45ca62ac548b1e8962c4202088 |
| #4169 | patch | fix/4169-scutil-atfork | 7da88d973f9dc3f7c0153f7b5000ef8e7bba2e9f | AM-OK | — | 1ee0b399eea2bda726a3cb141eecf8003564caa8e0e9e5d28a35fd6f32201755 / 去签名 c69d65c6ba6ddb74f61c51fbb17ef72b971da78eca33d44ad0fa42efd58173e3 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4172 | 已修复出列帖（台账排除单） | — | — | — | — | — | — | **SKIP-NOT-DELIVERED** | 台账排除单（11-05 审计判零动作 N.A.，但索引 05 文件存在 r123-AV 已修出列行——两账冲突，回笼核编年） |
| #4175 | patch | fix/4175-probe-model-403 | bc1488718e58256f6e4303879d70f9f8f31ae29c | AM-OK | — | 6f75e399b06da4f86b39162a93ec22cde69a1f42bf0a62caf246f4b421e94511 / 去签名 4ca2db30facbc11e6cfedc3afd29fd5363bd6897a5dd6c157323af576fe4568c | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4202 | 已修复出列+测试入仓（test-only patch） | fix/4202-nested-retryafter | 336926e944d854fb98a29ce764c29caf41e85498 | AM-OK | — | e4e6814fb7267bf46636e0972b6ae1595003291ddb25b6ef0a5c34f912ba47e2 / 去签名 8234cfa99c4d987cab161883486fc3535a9617f43b92010c8fb6fe6b98abeb12 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4241 | 验证帖（让位背书，verify 分支） | fix/4241-overage-window-verify | 319851618baf259f59bcf5e8d434e495aae12ee1 | AM-OK | — | f0ad307b0c315a5cf5db62585c2d0e1bebba32cfeab08e809b505d00626b64dd / 去签名 99d0bf6f4d18e63f42b67a578202be132f76c05b9bd4d214cd5a6a5f5e91d53a | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4242 | 让位核验帖（背书，Niko-Wu） | Niko-Wu fix/oss-batch @00adbe64（第三方；11-05 审计已判对 tip 冲突、待作者 rebase，本轮无新漂移） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4243 | 验证帖（让位背书，jailbreak07） | jailbreak07 kiro-rotation @3353bda6（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4271 | patch | fix/4271-plugin-count | 68caecbbafb2eebb6ff116492515a378e9e3aa4a | AM-OK | — | c19817808099419524f5de12a27360e6c69cade8a41e8f67508c3a032fa20a00 / 去签名 3ff10b8cdee695ac5a1400190d6b24bffc007207cf7cb130f62e6c05d6a2c320 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4282 | patch | fix/4282-body-size-limit | c45499dd0ceb952b71a4a5a135bcd0c46f98c866 | AM-OK | — | 265777e1779e5a585733c4d2eca6a92843d2af5e0a99728143f0dc15b621acf8 / 去签名 20d4bcddea40083ef69f970b8bdd8eecb540f610645cc2fa11ffc2ddbc1f47b0 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4317 | 已修复出列+测试入仓（test-only patch） | fix/4317-strict-429-scope | ee84f0add527485215e10e799b9c406b545e64e4 | AM-OK | — | 7d43a9aa3b48aa2f9b0760a5e604b4cac73ad93b6e8ec73a9cf447600151cef5 / 去签名 1d094398cf581da72cc6e0c182398f00947fdfc2776457060159c2092663efc3 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4324 | 验证帖（让位背书终验，verify 分支） | fix/4324-muse-phase-verify | 22770a3f0868db1a10d4fa48e7e995dd7d058c25 | AM-OK | — | 599bb5f4eda131626a3b95c534356d8f4e4b54abc604dfa1151d818a8e2aa00e / 去签名 44d4e67f44bc3c9ef63ed6755520a38ad06e12f7c7a7cc319a38f7320d8d1782 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |

## 总表（续 2）

| 单号 | 形态 | fork分支 | fix全SHA | merge-tree | 冲突文件 | sha256full（raw / 去签名） | 证据 | 四态 | 动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #4328 | patch（host 侧半） | fix/4328-kiro-credits | 0d25886acb9ce2399ac234ac12444dabd3e06458 | AM-OK | — | 0d8e1cf527a9560b813454c965430e22cc1d90f5115bf713bb712ad348ae2df4 / 去签名 5aa4e63765200133201ada8bf23040f60a9524014c0e0b06d74832c8d1679d47 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4335 | patch | fix/4335-daemon-tcc | 3ecb0f976eda488ad5b7baa15a29bacd8553b5a1 | AM-OK | — | ebd08eea136bd96845b8c4b24509d89e486294da3c4ef025f5b3e46ab35a204d / 去签名 82da9f0bd5bf4b0d06edc4d8080d3ecbdfb7f9dd83d756fe7431510ed4a558d3 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4337 | 已 landed 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4779 | patch（诊断半边） | fix/4779-untrusted-folder-502 | ff661481186d854c01ada26628e3c5706283ad5c | AM-OK | — | 284b29451e18a6e80c7497d7dbccfd64e07491d48f16fa44ff877e2acea87d52 / 去签名 81fb8defabde77313119944b4403cfd408a6a9e2b4ad08a4b825790487d02df5 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4780 | 验证帖（让位背书，verify 分支） | fix/4780-image-chip-verify | 3ccc1fc1b5b06017b7778925ea1bbd0850e8ebf9 | AM-OK | — | 8b1e7c18926b3766e1db893d01dd3533cef0f360ae04ba9627ce12df5dfee907 / 去签名 fa31cc747b9887caaae447138af0eef471d303407402a0e5b1c0607a1cd666c7 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4782 | patch（test-only） | fix/4782-callback-stage-diagnostics | 23a2ae2f8cc367799f3e5f4c54677c0d10d315a0 | AM-OK | — | b63f3b857135501ec11ab73bc435bb94af594d1fa205d8299df22cec0936ad93 / 去签名 641bb7463a4f36e0e72355ed5e76c1c95e5b073dc65fbfe52dba231e54dd6f56 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4798 | 已 landed 帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 c875e66c24052c34622cd410e8f9e3bf259dc188 |
| #4819 | patch | fix/4819-enum-cast | c4e7eb3ef0bf64fc18f07a773551eb183e3cb5f4 | AM-OK | — | da72bf6eaf50f1720519493bb656999db2be9c37964699b74ad27daebedb11e0 / 去签名 97bea6bd6a8982a31be6b49b92fa08a27ea0d3d2c50f24eb65a14b019880d4a3 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4863 | patch（诊断续作） | fix/4863-replay-cache-diagnose | 605b14910720c90e7c85a1382b87eb14e5e7c1ab | AM-OK | — | cdfc9db57982b131ab85722f6920876fb17d5fe1f36febce9480beca293eef63 / 去签名 6e18fa090d5f9d290efa11529e6511fd118d84fd47e363d628c2e9b46d974abb | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4874 | 验证帖（让位背书，skygunner） | skygunner b20255c62（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4882 | patch（test-only） | fix/4882-noisy-window-measure | 2f1b7444fb6deb80512de680960b27022a46272d | AM-OK | — | 529a257fcb02bc000a3ffaa7ef02c769ffe615a01a7646b5f68b30554df80c4f / 去签名 ddcf21762e30bcadc5fbe5930720e6d08254456aac15d45e8425a85840de5163 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4884 | 答疑帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4893 | 判定帖+基线 bench | fork fix/4893-sniffer-bench-clean @fb93b132a（bench 落仓，非 am 面） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4945 | 让位分析帖（skygunner） | skygunner fix/4945-deepseek-parallel-tool-uses @8847ef602（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4972 | patch | fix/4972-copilot-luna-400 | ada3dcdc5c1692847b6819b4a07880e9f015d85e | AM-OK | — | d277dc5f2a253af9ed854c4718c69af8978157662422d38231096e71b0ee1fdd / 去签名 7e1b186098bf084e1f66bc6f0f383da1c25b50868d4b38ec8280b9f6ff828353 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4973 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4978 | patch | fix/4978-fork-exec-502 | dc954ac28ee134d7a844a1e4f368eaecd8039034 | AM-OK | — | 79d6f64fb62ebc4ebb1dec665dca53b65167ee73dccf604c59b5eb469d352c9c / 去签名 f08a4280c3ec6fa9a9c9f0154d98e6467626b9ca3196c2e0dae56ba071609b4c | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4980 | patch | fix/4980-agent-version-refresh | 473f0ac3d77496f9ceb128496fe0bc536772a85b | AM-OK | — | 6d8fa0297c8f5cdc9ec516d18ba6c2d5a9bf6313a1f16809d52ad2f493bc301a / 去签名 defbbaf3479f6f48ff27c9c67ff5570c78a8761f4db7598449c0ce8713f203bd | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #4985 | 已 landed 帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #4987 | patch | fix/4987-zcode-shared-skills | 760fd169bed62743765e75ae3340edaed6e10c20 | AM-OK | — | e26a7fa92e2260300e4a6a7cf2edd80aa042d75d4000a16aadfa937c8b11827a / 去签名 909dddaea801760dbcdcd8ca24a83cd4be71de79baa0093e2fe7bcd28850bf9b | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4988 | 取证帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 3d7b1233ddf1bad5d99eeaeb18ca36cf7fdb4db5 |
| #4993 | patch | fix/4993-webdav-conditional-get | 68e57a485b87ff8b5220e5acb86d3d3443755314 | AM-OK | — | 402291743920dfefb82c847e9f11f8bb2242cf045a923f45ff27afd9538f9094 / 去签名 16bf4a698ffed19320936c9be4fb6302ff824c0f7df1487bcfc7705c75c8eae7 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #4995 | patch | fix/4995-usage-denied-words | 0b7eed05ac49375ee2e411f3a9aac98e3da2a47c | AM-OK | — | e287cb7e6fe36a17e99104a427749978a53e6e7e938c93116e574cab46436ed7 / 去签名 020dac0505421987b90a3fd8686a5e5a67aae7cc48fa6aa7634e8f36af1aa358 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5002 | patch | fix/5002-redact-rules | 4009e8f9b840af59ab14dbd293128559bb78abc2 | AM-OK | — | 35e48e6274515929a3c95f924eefafb76d2639aa0ef2d22879734d3ac8f3d1cd / 去签名 62769737a4c9243d6e503667dc769af976bfdd5a0329d96d1552de5f391891fb | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5006 | patch | fix/5006-sensenova-429 | a2b76e64f281dff3797d0f6234c066321fb1b4b1 | AM-OK | — | a801c471bb0a895d82b727ce07ba33778a1c7cfc488ecc9d431fc3966300930e / 去签名 928376358de41a00efd1513a29ffbf55ec15d7bdf061939d8615b5ae46ffcfcc | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5008 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5009 | linkage 帖 | hunt/2526-retry-after-sync @928da841（linkage 面，非本轮 am 对象） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5010 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5012 | 验证帖（让位背书，verify 分支） | fix/5012-setup-token-allowance-verify | 03f3f60114fa92d3d1be191bfc17106036cbffc2 | AM-OK | — | 1ea061f46adc0ebcd7711a00f16b773a632130c2f8e7874c6adf28d79afad036 / 去签名 5ee9c11a7ca1550a34d2fd9dcd6c4c379849cc3967e5463b959513b08ca85061 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |

## 总表（续 3）

| 单号 | 形态 | fork分支 | fix全SHA | merge-tree | 冲突文件 | sha256full（raw / 去签名） | 证据 | 四态 | 动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5020 | patch | fix/5020-checkin-catchup | 3aef9965625781a6610b0b6cf53f045301d86d6c | AM-OK | — | c3471041dc8aa553f61a791ee5c88f4abcc6ca2acb1e66547086e14b65ef756c / 去签名 fabb558a0b6431fab878ccb09bba888d9f90ecbeb0277fe8cff880ede87cdff9 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5022 | 评估帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5024 | patch | fix/5024-reasoning-description | ecfd02e32c6549dd62b22980f14977f9e67a81e7 | AM-OK | — | 82527efd0ebbd1da4a9b2a0c9b0f96655fa1294632f7889e3cd3cd0899b6a0f1 / 去签名 ac016db5bfcab23fc85de3a176fc2ade9e14a6c7b54b3d895cb32d38add488ea | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5030 | patch | fix/5030-maxtokens-field | c00bbc01537c07eef41e324487bca44943d4726f | AM-OK | — | 6a6048492614a463f30ecac322fed0373fb83a15b102f148e33b2321d222b53a / 去签名 f0d7f0071991fc048efede444c08f70793b23c884bae8ae2cf13070d3c555a85 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5032 | 取证帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5033 | 诊断帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5043 | 已 landed 帖 | — | — | — | — | — | — | **LANLED** | 出列：tip 合入 40a287b217660c3cb33becc1b911ed8479b5d335 |
| #5064 | patch | fix/5064-opencode-v2-providers | 95e20fd8020cbd4f2c99176974a7033117a08331 | AM-OK | — | e991122c963a54bd0d07a39e41a12601df8cab0b153d9afd548d79749e3ff8da / 去签名 2f61969a62f8bc6cdbb74622201428c975f7c050ff83a354c5d4f44ad37946bb | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5065 | patch | fix/5065-omp-remote-compaction2 | 95e4e2660b1b78aad80517aeddc7509809d04fc3 | AM-OK | — | 916b22f501127ef1008b88c7f558b5e40eeb994046d761e222e052448601f69e / 去签名 97c365256f18253e292976882b134b49d76540e7fbc3f77253d67bf7de55ed8d | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5066 | 已 landed 帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5067 | patch | fix/5067-compaction-system-messages | b39eb4f0cd13298417d5ae593f8e32022cdb9278 | AM-OK | — | 8dd09d8690201bad3e7647132d5e7c600931ba060dd79b341076653bf8e42b82 / 去签名 6878326ed38234326ca879f1b125a14d5e0452ba4ca4db95ea34365244d9039b | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5078 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5082 | patch | fix/5082-session-title-schema | 0410970dc24b85a2baa3eb5b5d8734f96f923849 | AM-OK | — | 4ba8f198a6de76e32a5152c80606a3d9cc66c4317999731ac101f346bfe5c7d5 / 去签名 25014caaa18b41490514e358f9aca48f1ad3cbde89a40b1c44bf54326b7f59a5 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5083 | 验证帖（让位背书，verify 分支） | fix/5083-editor-kept-proxies-verify | c4ddc0e2254512d03e11d7993d0974404d596925 | AM-OK | — | b392e835663a52ca585e09a8c8c064c58dc0a16e781602125436297fd0a29c16 / 去签名 e6a83a5a5b678891f11ceab9fe0d7c8af1e3427a0200faf11005e3dc74c27045 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5084 | 验证帖（让位背书，verify 分支） | fix/5084-tui-allowance-verify | 45b1eec99aa530a958e42f0f6c6b153354b45b25 | AM-OK | — | f453e0a79226790e731e613da158efa89770c03100172b3361f0fff4add32c00 / 去签名 e3e1b5c1a264bbf1c1abdb497e387895798fa4df10f62d58e3d206f8cd1b68c4 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5086 | 验证帖（让位背书，verify 分支） | fix/5086-catalog-absolute-verify | aaeb9f4ddb0060568be5df748f6371fb086ac99e | AM-OK | — | cf5fbfb9446ae2303ffdb357fcd790e4afc77066fb79527dfdb0537ef8440818 / 去签名 a60238a3ae56fc69d82282c10f943facda50f60be95b9a0433d937a379732186 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5087 | patch | fix/5087-mistral-allowance | 2eceed5c2f6a60a8dec674a648d8f1f1254b0da8 | AM-OK | — | 257a35d4a83b834190d04ec32cd6e8277a9060a52ef8804229a3a0a0307deee5 / 去签名 7f7bed38fbff4f04f7de14cd29037e0e15a15144b2982454b22008cb2b3f76c8 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5099 | 判定帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5100 | patch | fix/5100-drift-own-claude | 22d2d4ede781490e0d4308cf77dfabf555869a20 | AM-OK | — | 611e323996ff4392dedcc4b0f2dae322d3841417ec2bbe03b5cbb9d8ef779046 / 去签名 8874e534f8a706bfc16ee3c9080a4133461ef603142e5496dcc6089f094d6968 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5101 | patch | fix/5101-jev-intent-sure | 96f8821136e59b485f6e14c90f3bd83fd7b31df6 | AM-OK | — | e00a4826817a161e8a2f810dbabfa3c5f843d97abf5ad45f5f2196bbf1962da8 / 去签名 c3b21f9431a9e006d2c502027dada8b86524454f35bad898c5123c806744a9ae | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5103 | patch（rework 后） | fix/5103-provider-icon | ac22f82f349f7aa91d975b82d6a51b7fa1641315 | AM-OK | — | 94b288e549d6a2c26f0a3648526e9f3c0d85952ce582d3484e7162b7372b0777 / 去签名 7c484d747cda0c76dd48d7dc53fd6d4c79205e590dad11edfde32baf189717e9 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5104 | patch | fix/5104-login-lock-convoy | ecb829370a6a8a681c86d04f860816d3aed2b9bc | AM-OK | — | aeab040be58a831623586a4f25f33ceefe4dd0644e509ef0d0a950c6f2918f65 / 去签名 53b7dae9dc6d1a43003b7e39fe81b1fb81749ead1839663e5ec3903a82624006 | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5106 | patch（对照） | fix/5106-thinking-tag | 7e3f194b2025f37452457da506fd81886145598c | AM-OK | — | d4c92e45c44d894be26211efe7a44df15207c3d51ffe257d331d5f594ae1cf1b / 去签名 9f375f80672b7fd4c0da4e39ff4eff0710411ae2d8a128d944b4d8bf68313cfe | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5108 | 让位分析帖 | 报告者自带 qwenCall patch（第三方） | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5111 | patch | fix/5111-litellm-budget-429 | ba42bfcd52e460d69d2ec6eb655838bdd6f6f3b7 | AM-OK | — | d7fbb1dc7b4548f2b4c63d1a5e3c4567c3bfbcaccee6187ae633b830efc7a0b5 / 去签名 ee4cc606da177b24ba5f804d3050fc210084508e3dabe2ff676f71559b476dc9 | RERUN-PENDING | **READY** | 定向+消融复跑待排队（四车道并发占机，本轮不重跑不添噪） |
| #5114 | 答疑帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5115 | patch | fix/5115-token-inflation | c6161fac99d18655ad39a38b1fd1a8f78cd30037 | AM-OK | — | a4f299c468731fff21a13fb5244ca5b9a414bd5ddc033d7b1c827978d5c26285 / 去签名 c069cffd1e31939be0f10e7f3a893f4da4e71b30db56ce3472e7cee0cb4b6a3d | REUSED | **READY** | 证据沿用 11-05 审计 |
| #5116 | 取证帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |
| #5117 | 答疑帖 | — | — | N.A. | — | — | — | **N.A.** | 非 patch 形态，无分支可 am；帖/判定可解析 |

## REWORK 队列（冲突支）

| issue | 分支 | fix全SHA | 冲突文件 |
| --- | --- | --- | --- |
| #4108 | fix/4108-agent-message-verify | e1aabd98f0c067de84f45ed306b8743d0fb3414e | internal/gateway/codex_backend.go（content CONFLICT；gateway.go 自动并干净） |

## PATCH 清单（帖内错指/缺记，只列不改）

| issue | 问题 |
| --- | --- |
| #4780 | 帖/索引记 verify head `4325be0e7`，fork `fix/4780-image-chip-verify` 现 tip 为 `3ccc1fc1b5b06017b7778925ea1bbd0850e8ebf9`（提交时刻 11-04 18:01+0800，早于今审计），旧对象 fetch 全量后不存在——帖内 head 已不可解析，需作者更正；现 tip 对冻结 tip merge-tree AM-OK |

## 备注（不计 PATCH）

- **sha256 口径**：本轮 raw=LF（git 输出无 CRLF）；另记去签名值（format-patch 尾部 git 版本签名 `-- / 2.55.0.windows.4` 因工具链而异，导致与今审计 macOS 侧记录的 sha256 前 16 不可逐字节对账——head 全 SHA 逐一 tip-eq 核同，commit 对象同一即内容同一，故不据哈希差记 PATCH）。
- **#2965**：索引 hunt49 行仍记分支 `hunt49-a-builds-once`（旧头 `d7136798`），rework 头 `76f8fd7fb` 实际在 `fix/2965-providers-once-load`（tip-eq）；新行（r123-AW2）只记 head 未记分支，不算错指，建议台账统一。
- **#4172**：任务排除单要求 SKIP-NOT-DELIVERED，但索引 05 文件存在 r123-AV 已修出列行（帖 6618947752）——两账冲突已按任务口径标 SKIP，提请回笼核对。
- **#4069**：其 fix `f10443d26` 叠在 #4166 的 `fix/4166-thinking-stream-group` 分支上；#4166 本轮确认 LANLED（上游 `0a5dc40ab` 已落同区域 thinking 流接管），#4069 merge-tree 虽干净，语义上需与 tip 新落实现重对（记 READY，动作为复跑时加验语义）。

## 总账

**READY 67 / REWORK 2 / LANLED 9 / DEAD 0 / SKIP-NOT-DELIVERED 1 / N.A. 37（合 116）**（补跑收口后的终值，见下节；初判 READY 68/REWORK 1 中 #4108 已收口回 READY，#4780/#5067 补跑后转入 REWORK）。

## 补跑收口（R1/R2/R3 车道，2026-11-05 晚）

- 逐支明细：[inflight-rerun-r1.md](inflight-rerun-r1.md)（18 支：17 + #4069 语义加验）+ [inflight-rerun-r2.md](inflight-rerun-r2.md)（17 支）。
- 35 支 RERUN-PENDING 补跑结果：**RERUN-OK 32 / REWORK 2 / 平台受阻 1**（#4978：新测试属 `#!/bin/sh` 替身家族，Windows 硬 SKIP，本机无 WSL/Docker，红→绿无法实证；guard 逻辑平台无关，证据沿用 11-05 darwin 在案，POSIX 车道补跑待排）。
- **#4108 REWORK 已收口 → READY**：新 head `1148ac8dc94003fcf40e114f46ce70ed4f526205`（作者 hqhq1025 保留；codex_backend.go 与 tip #5275 `compactWithin` 按"双方语义并存"解，#3183/#4910 确认为原基祖先）；定向 6 测 + 消融回红复绿 + `-race` PASS；mbox sha256 full `5ff361e0236e09c0b7738d210bbdb54c77b9fe6afd3a86dd571ae73ad4cebf1b`；am -3 AM-OK 树一致；force-with-lease 已推 `fix/4108-agent-message-verify`；背书帖 6636789845 已 PATCH，GET 回读旧值（`e1aabd98f`/`ad68feeb`）零残留。
- R16 三支 `-race` 缺口关闭：#5062 / #5075 零 DATA RACE（5 红均为干净 tip 同栈复现的预存环境红/harness 竞争 gateway.go:884）；#5085 `-race` 定向全绿。issue 帖未动。
- **REWORK 队列（供下一轮 rebase 取用）**：

| issue | 分支 | fix全SHA | 问题 |
| --- | --- | --- | --- |
| #5067 | fix/5067-compaction-system-messages | b39eb4f0cd13298417d5ae593f8e32022cdb9278 | `codex_backend.go` 与 tip #5275 `lateSummary` 同区实挑冲突（merge-tree 早判 AM-OK 与实挑不符，以实挑为准） |
| #4780 | fix/4780-image-chip-verify | 3ccc1fc1b5b06017b7778925ea1bbd0850e8ebf9 | tip #5283 `readDone` 语义致测试 harness 红（Windows 实测 `close of nil channel`；darwin 声称未被推翻，需作者补 harness 或 darwin 复跑裁定） |

### 三条最要紧发现

1. **#4108 成为唯一新 REWORK**：其 verify 分支 `e1aabd98f` 对冻结 tip 在 `internal/gateway/codex_backend.go` 内容冲突（tip 新落 #3183 tool_use id salt、#4910 同文件）；今审计 PASS 后 tip 漂移所致，需作者 rebase。
2. **35/68 支 READY 的触面撞上今 tip 漂移（191 文件 / 约 5000 提交窗口），证据需补定向+消融复跑**；本轮四车道并发占机且套件含时敏测试（互相加噪），按任务规则全部标 RERUN-PENDING 排队，未在本轮跑——建议等车道清空后按表逐支补跑。
3. **#4780 帖内 verify head `4325be0e7` 已失效**（分支现 tip `3ccc1fc1`，旧对象不在远端），是今审计之后唯一的帖-远端指认漂移；另 #4172 排除单与索引 r123-AV 行两账冲突，需要人裁。

## 11-05 晚批测（tip `326e72f4c`，移植潮 50 笔后）

- 64 支 READY（排除 #4780/#5067 实挑 REWORK、#5104 已收编、#5115 已关）对新 tip 重跑 merge-tree：**57 CLEAN / 7 CONFLICT**。窗口 50 笔主题粗扫无本批单号命中，7 支冲突末评扫描无收编形态——定性纯触面漂移。
- 出列转 REWORK：#3700/#3844（internal/agent/apprestart.go）、#3967（internal/gateway/fallback.go+gateway.go）、#4034（docs/subsystems/providers-accounts.md）、#4077（internal/gateway/upstream_transport.go）、#4779（internal/claudetui/tui.go）、#5100（internal/gateway/claude_warmup.go，催点支，rebase 后入下批）。
- 判例：**批测批分支名时本地缺失分支用 `origin/<branch>` 重跑**——13 支「冲突文件空」假阳性实为本地无此分支（merge-tree 报 not something we can merge 落进冲突桶）；fetch origin 全分支后 12/13 CLEAN，仅 #5100 真冲突。
- 附：origin/fix/5085-capcareful-stale 已被 R4 rework 车道 rebase 并 force-push（be674dccf→87407ed09 起）。
