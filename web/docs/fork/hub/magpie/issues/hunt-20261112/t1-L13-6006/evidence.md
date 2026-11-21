# t1-L13 · #6006 跟进帖取证记录（2026-11-13）

## 定性

- 单号：yetone/magpie#6006（WhyULose，2026-11-10，OPEN，c2）
- 我方在案两帖：`take`（6780011098）+ 判定帖（6780024979，读码 2.1.312/2.1.322 bundle：skillOverrides 键=文件夹名，front matter name=displayName）
- 三查（2026-11-13）：
  1. 末评=我方判定帖，无任何新回合（issue updatedAt=2026-11-10T21:42:31Z=我帖时刻）；
  2. fork 无 6006 相关分支（ls-remote grep 零命中）；
  3. 收编三查零命中：`git log --all --grep=6006` 仅 94f6f6092 推文 id 数字巧合（lower+contains 已排除）；open/全量 PR 正文零引用；upstream/internal/library 自 87b3af765 后 project_scope.go 零改动，skills.go 改动均不触 nameFor/fitName/syncSkillsOff 语义。
- #5705 修复 9730e0199 = gateway 域（claude_subscription.go + 测试），与 library 不同文件域，无需并核。
- #6319（t1-M-6319）= regroup Group 绑定表，另表；本单 skillOverrides 键表不重复取证。

## 处置

判定帖的未答面=报告者侧决定性实验（帖内承诺：实验推翻我读法则交 patch）。本次自行闭合：本机 claude 2.1.322（=npm latest，2026-11-10 发布）现场跑 A/B/C 矩阵 → 判定帖结论现场复现 → **跟进帖（现场矩阵证据），非 patch**（按报告者期望写 front matter name 反而是真错配）。

## 实验环境

- macOS darwin 24.6.0 arm64；本地 `claude` 2.1.322（Keychain 认证，真实 HOME；项目在 /tmp 隔离）
- 会话经本机所配模型路由（stderr 有 `[claude-code:unrecognized_model] {"model":"auto/GLM-5.3-Flash[1m]"}` 及一条 Windows 路径 SessionEnd hook 失败噪音）——技能列表与 override 门均为客户端行为，与后端模型无关
- 技能 SKILL.md：folder `my-dir`（项目级）/ `my-dir-l13`（个人级），front matter `name: My Skill`

## 原始输出（逐字）

项目级（cwd=/tmp/mg-t1L13-6006-exp/proj）：

1. 控制组（无 settings.local.json），问 "List the names of all skills available…"：列表含 `my-dir`（以文件夹名列出，非 "My Skill"），同列表还含 ~/.claude/skills 各技能（anatomy、grilling…，均按文件夹名）。
2. Test A（`{"skillOverrides": {"my-dir": "off"}}`）：grep `my.dir|my skill|marker` 零命中（GREP_EXIT=1）；另跑计数会话答 65。
3. Test B（`{"skillOverrides": {"My Skill": "off"}}`）：grep `my-dir|my skill` 计 1（技能在列）；随后删除 settings 控制组问 "Is a skill named my-dir available?" → `YES`。

个人级镜像（报告者场景本体：~/.claude/skills/my-dir-l13 + 项目 settings.local.json；跑毕即删）：

```
A(personal): key=my-dir-l13 -> NO
B(personal): key=My Skill  -> YES
C(personal): no override   -> YES
```

## 结论

- Claude Code 2.1.322（=npm latest）现场实证：skillOverrides 键匹配**文件夹名**；front matter `name` 作键**无效**。
- magpie 写键（nameFor → 链接目录名 → syncSkillsOff）=同一文件夹名 → 关得掉；报告者期望形态才是真错配。
- 判定帖前提现场成立，issue 前提反转；无 patch 可交。

## 清理

- /Users/ggbdpq/.claude/skills/my-dir-l13 已删（本次创建，grep 确认 0）
- /tmp/mg-t1L13-6006-exp 待收口删除（含 home/.claude.json 与 proj；CLAUDE_CONFIG_DIR 隔离树）
- 副作用声明：真实 ~/.claude.json 增一条 /tmp 项目 entries（claude 正常行为，未回改用户配置）

## Not verified / 不自信

- 未在 2.1.312（报告者实测版本）现场复跑——本机无该版本，bundle 读码两版一致是间接证据
- 报告者 "2.1.312 实测键认 front matter name" 与我方读码+2.1.322 现场矩阵矛盾，无法解释其观察来源（不自信点：可能其场景另有形状，如技能非 magpie 链接或插件技能）
- 维护者零表态，判定≠结案；单仍 open
