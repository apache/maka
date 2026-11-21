# PR 过程命令手册（apache/maka）

> **本文件是什么**：专门收录给 apache/maka 提 PR 全流程实际用过的命令，按干活顺序排列，按当前阶段查。
> **收录标准**：每条命令都在本机（Windows + Git Bash）实测过或产出过真实结果；没验证过的不收，待验证的会标注。
> **三条红线**：① 令牌只在单命令的 shell 变量里流转，**永不 echo、永不落盘**；② git 操作用 `git -C`，不 cd（fnm 钩子会截断命令链）；③ 本文件是个人文档，**绝不提交进任何仓库/PR**。
>
> 最后核验：2026-09-04

## 一、开工同步（每天干活第一步，不是每单一次）

```bash
# 同步上游最新代码（只更新远端引用，不动工作区、不动本地 main）
git -C "E:\ggbdpq\gh-fork\maka" fetch upstream main

# 新分支一律从 upstream/main 切，起点必须显式写；绝不从本地落后的 main 切
git -C "E:\ggbdpq\gh-fork\maka" checkout -b <fix|docs>/短横线描述 upstream/main
```

分支已存在需刷新时（rebase 到最新）：

```bash
git -C "E:\ggbdpq\gh-fork\maka" checkout <分支>
git -C "E:\ggbdpq\gh-fork\maka" rebase upstream/main
git -C "E:\ggbdpq\gh-fork\maka" push --force-with-lease origin <分支>
```

## 二、环境自检与修复

```bash
git -C "E:\ggbdpq\gh-fork\maka" status          # git 活着，能出结果
node -v                                          # ≥ 22.19.0（fnm 管理）
ls node_modules/.bin | wc -l                     # 在仓库根执行；等于 0 = 半截安装
npm install --ignore-scripts --no-audit --no-fund  # 补装半截 node_modules，约 1 分钟
```

必须 cd 时先执行（否则 fnm 钩子报错且以退出码 1 截断 `&&` 链）：

```bash
eval "$(fnm env)" 2>/dev/null
```

测试卡在 `Downloading Electron binary...`（上游 bump electron 后，`--ignore-scripts` 跳过了二进制下载）：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js
```

epoch 冲突解完后的强制验证（要求输出 "epoch moved" 且退出码 0）：

```bash
node scripts/protocol-epoch-check.mjs --base upstream/main --head HEAD
```

## 三、认领与评论（take / untake / gentle ping）

```bash
# 取令牌（只在变量里流转）；然后发认领评论，正文必须恰好一个词 take（放弃用 untake）
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/apache/maka/issues/<编号>/comments" -d '{"body":"take"}'
```

## 四、查询（全部走 api.github.com，网页抓取会超时）

```bash
# PR 状态（open/merged、head SHA、评论数）
curl -s "https://api.github.com/repos/apache/maka/pulls/<编号>" | python -m json.tool | head -30

# review 意见列表 / issue 区评论列表
curl -s "https://api.github.com/repos/apache/maka/pulls/<编号>/reviews"
curl -s "https://api.github.com/repos/apache/maka/issues/<编号>/comments"

# 某个 head SHA 的 CI 检查结果（红叉定性第一步）
curl -s "https://api.github.com/repos/apache/maka/commits/<head SHA>/check-runs" \
  -H "Accept: application/vnd.github+json"

# 判断某组是否被人认领：看 issue 评论 + assignee，0 评论 ≠ 没人认领
curl -s "https://api.github.com/repos/apache/maka/issues/<编号>/comments?per_page=20"
```

CI 红叉定性三步：先分清 queued/failure/分支保护（queued 不是失败）→ 抓失败日志 `##[error]` 前后 20 行 → 与失败测试零重叠要用**新鲜 fetch 的** upstream/main 做 diff。完整 SOP 见 [04-CI排障与测试.md](../../guide/04-CI排障与测试.md)。

## 四点五、desktop 架构检查（CI "Check renderer architecture"，2026-09-08 核实）

```bash
# 本地等价复演（必须过再推；base 用 upstream/main 与 CI 对齐）
cd apps/desktop && node scripts/check-renderer-architecture.mjs --base upstream/main
# 冻结区（legacyAppShell.files，app-shell.tsx 等）token/指标精确相等，改动挪非冻结面
# feature 类型 import 只走 index/testing；新 re-export 加 src/renderer/features/workbar/testing.ts
# 红叉定位：commits/{sha}/check-runs → runs/{id}/jobs → job logs grep "##[error]"
```

## 五、验证矩阵（脚本名已对照根 package.json 核实，2026-09-04）

```bash
npm run format:check        # biome format .，格式检查
npm run check:asf-headers   # 新文件 ASF 许可证头检查
npm run check:asf-source    # 发布链源头检查（文档 PR 至少跑前两条）
npm test                    # 全量测试；后台跑时输出落文件再 grep，别接 | tail
```

重跑单个测试文件（定性失败用，单跑即绿说明是合跑互踩不是代码 bug）：

```bash
node --test packages/<包>/dist/__tests__/<文件>.test.js
```

## 六、提交与推送

```bash
git -C "E:\ggbdpq\gh-fork\maka" add <文件...>
git -C "E:\ggbdpq\gh-fork\maka" commit -F commit-msg.txt   # 多行 commit 消息用 -F 文件，别用 -m 拼转义
git -C "E:\ggbdpq\gh-fork\maka" push -u origin <分支>
```

commit 消息格式：`type(scope): 摘要` + 正文（根因/修法）+ `Fixes #N`（或审计轨 `Refs #3522`）+ `Generated-by: GLM-5.3-Flash (ZCode)` 尾注。

提交身份（2026-09-29 固定）：gh-fork 下所有仓库的作者/提交者一律 `ggbdpq <ggbdpq@gmail.com>`，禁止「关天豪」「小七」等其它身份。已两层固定：全局 `.gitconfig` 的 `includeIf "gitdir:E:/ggbdpq/gh-fork/"` → `.gitconfig-ggbdpq`，外加各仓库本地 `user.name`/`user.email`。新 clone 或身份异常时先跑 `git config --show-origin user.name user.email` 核对来源；历史提交里的「关天豪 <ggbdpq@gmail.com>」是旧配置产物，email 正确所以 GitHub 贡献图仍计入 ggbdpq，不改写历史。

## 七、开 PR

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
# 先把 PR 正文写进 body.json 再引用，避免 shell 转义地狱（python -c 'import json;print(...)' 生成）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/apache/maka/pulls" \
  -d @body.json
# body.json: {"title":"...","head":"ggbdpq:<分支名>","base":"main","body":"<四段正文：Summary/Verification/AI use/Checklist>"}
```

PR 正文验证表用「声明 → 验证命令 → 结果」三列格式（#3523/#3555 提炼的快速合并格式）。

## 八、gh CLI（2026-09-04 新装，登录待完成）

```bash
winget install --id GitHub.cli     # 已执行：装好 2.100.0
```

- 旧 Git Bash 会话 PATH 不刷新，用完整路径；**新开的终端直接敲 `gh` 即可**：

```bash
"/c/Program Files/GitHub CLI/gh.exe" --version    # 已实测：gh version 2.100.0
```

- **待办：首次登录必须本人做**（交互式设备码，浏览器确认；git 凭据里的令牌缺 read:org，`--with-token` 方式实测被拒）：

```bash
gh auth login    # 选 GitHub.com → HTTPS → Login with a web browser
gh auth status   # 登录后核验
```

- 登录完成后，第四节和第七节的 curl 可逐步换成 `gh pr view / gh pr checks / gh pr create`（**待实测后回填**，实测前 curl 路径继续用）。
