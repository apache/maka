# maka 并行克隆撤除档案——Windows 侧（2026-10-17）

> Windows fork/maka-hub 解包（对齐 Mac 同款结构，Mac 先例见 `_removed-parallel-clones-archive.md`）。WIP 处置经用户确认走**本地 bundle+patch 存档**，未推送任何远端。恢复方法：在有 upstream/main 历史的仓库（如 fork/maka）中 `git fetch <bundle路径> wip/pre-teardown-windows`，或直接 `git apply <patch>`。

## maka-pr1
- 原分支: fix/tui-rewind-quote-staging（tip 90ae756fd352d2f88e1ceedd147e10b653d66c6b，已在 origin；与 Mac 档案 make-pr2 记录的分支头一致）
- WIP: 5 文件 +522/−573（packages/cli/src/pi-tui-runner.ts、tui-copy-catalog.ts、scripts/check-tui-copy.mjs、pi-tui-runner.test.ts、package-lock.json）
- wip 分支提交: b95f2a8f26306a3cb74c61f136d6ccc93db803cc（wip/pre-teardown-windows）
- 存档: `_bundles/maka-pr1-wip.bundle`（增量，排除 upstream/main）+ `_bundles/maka-pr1-wip.patch`

## maka-pr2
- 原分支: fix/5958-transcript-export-markdown（tip ebd03da9620a2b2e058ae8de5c94550ac4e0a1d9，已在 origin；与 Mac 档案 make-pr3 记录的分支头一致）
- WIP: 10 文件 +402/−67（packages/runtime/src/session-transcript-export.ts 及测试、packages/core 与 apps/desktop 的 conversation-markdown 及测试、packages/cli/src/session-export-markdown-command.ts 及测试、CHANGELOG.md、package-lock.json）
- wip 分支提交: 24693d116f87cc9334cae5fa5fb290f7896624db
- 存档: `_bundles/maka-pr2-wip.bundle` + `_bundles/maka-pr2-wip.patch`

## maka-pr3
- 原分支: fix/workhub-provider-icons（tip fd51dc5c8e0634971668e0ee46ede159a6a6b8da，已在 origin）
- WIP: 仅 package-lock.json 1 行
- wip 分支提交: 65f8efd8e3aadcd5e9e6097b6b248fb9b5dbd10a
- 存档: `_bundles/maka-pr3-wip.bundle` + `_bundles/maka-pr3-wip.patch`

## maka 主 clone（上提为 fork/maka，未删除）
- 撤除时所在分支: fix/workhub-tool-id-turn-scope（package-lock.json 有 1 处未提交修改，随 clone 原样保留）
- 未推送提交（本地分支 fix/run-unrelated-success-boundary、pr-4566 持有，随 clone 原样保留）:
  - 0796f1112 refactor(cli): collapse boundary tracking to a single boolean
  - 61db50928 test(runtime-host): bound test wait helpers by wall-clock deadlines
- stash 2 条原样保留（4814-wip、stash before 4514 rebase）

## multica / orca（原样提层，无独有工作，未推送）
- multica → fork/multica: main 7ab92d762 = upstream/main（fork origin/main 落后 43，无独有提交），工作区干净
- orca → fork/orca: main 464bd5a54b = origin/main；fix/all-types-tab-cycle-in-terminal 8385e41e2f = 远端对应，工作区干净

## 文档与日志迁移
- 迁入 hub/maka/pr/: PR-JOURNAL.md、cases.md、commands.md、workflow.md；docs/pr/journal/{audit,claims,retrospective,reviews}.md → pr/journal/
- 冲突留在原地 fork/maka-hub/docs/（不覆盖 Mac 版）: 01-环境搭建.md、README.md（内容有差异）、02-查询与同步.md、03-maka机制与棘轮.md、04-CI排障与测试.md、05-review意见处理.md、10-maka-orca-multica对比.md（与 Mac guide/ 字节相同）、pr/README.md
- 26 个非空 *.log → hub/maka/logs/（无空文件）
