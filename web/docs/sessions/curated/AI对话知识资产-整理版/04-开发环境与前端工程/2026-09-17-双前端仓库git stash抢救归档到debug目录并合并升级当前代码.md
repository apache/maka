# 双前端仓库 git stash 抢救归档到 .debug 目录并合并升级当前代码

> 会话执行日：2026-09-17（部分收尾在 2026-09-23 前完成）；涉及仓库：`E:\Projects\frontend\homing-miniapp-workbench`、`E:\Projects\frontend\beauty-smart-advisor`

## 1. 问题背景与目标

两个前端仓库里积压了数月未处理的 git stash（homing 5 个、advisor 6 个），代码严重落后于当前分支。其中最关键的 `directCosFlash.ts`（直连 COS 创建闪记调试核心）是 untracked 文件，**只存在于 stash 的隐藏第三父提交里**，工作区和提交历史都没有——stash 一旦被清理即彻底丢失。

用户目标（逐步明确，最终形态）：

1. 所有 stash 提取到各仓库本地 `.debug/` 目录，**不是 diff patch，而是完整文件快照**；
2. 每个 stash 一个文件夹，命名 `001+中文具体做了啥`；`.debug` 根目录一个 `README.md` 做索引；
3. 提取后在**当前最新代码基础上合并升级**（快照落后几个月，直接快照价值打折）；
4. `.gitignore` 忽略 `.debug/`，AGENTS.md 明文红线：**绝不允许 `.debug` 进暂存区或提交**；
5. 校验完整性后**删除全部 stash**（两轮均获用户明确授权后执行）。

## 2. 最终落地方案

### 目录与命名约定（两仓库同构）

```
<仓库根>/.debug/
  README.md                     # 索引：原stash编号、日期、base提交、内容说明、恢复方式、跨目录依赖
  001中文描述/
    <原仓库相对路径>/...        # stash 触及的 tracked 文件 = 当前代码+stash增量的合并结果
    <untracked新增文件>          # 原样保留（当前仓库无同名物时）
```

- 文件夹编号按 stash 列表序（`stash@{0}`→001 起，最新在前）。
- 合并结果统一 LF 行尾、无 BOM。
- 当前仓库已不存在的文件保留原始快照（如 advisor 的 `GlobalSkeleton` 组件——该功能后来被整体移除，**完整源码仅存于归档**）；`package-lock.json` 不做机械合并，保留快照（合并锁文件无参考价值）。

### 配套红线规则（可复用文本）

`.gitignore`（按各仓库既有风格插入）：

```
# 本地调试文件目录（个人备份，禁止入库，见 AGENTS.md）
.debug/
```

AGENTS.md（homing 仓库独立成节「.debug 本地调试目录（红线）」；advisor 仓库追加进「6. Git、提交与沉淀」节）：

> `.debug/` 仅存个人本地调试文件（当前为已清空的 N 个 git stash 的归档，目录索引与恢复方式见 `.debug/README.md`），已被 `.gitignore` 忽略，只存本机。**绝不允许 `.debug` 下任何文件进入暂存区或提交**：包括 `git add -f .debug/...` 在内的一切强制添加；`git add -A` / `git commit` 前若发现 `.debug` 条目，立即 `git restore --staged` 撤下。

注意：advisor 仓库的 `AGENTS.md` 本身被其 `.gitignore` 忽略（AI 协作规则文件节），红线规则天然不出本机。

## 3. 关键技术结论

### stash 解剖结构

- `git stash show -p stash@{n}` **只含 tracked 改动**；untracked 文件存在第三父提交 `stash@{n}^3`（`git stash -u` 才有；无 untracked 时该提交不存在，用 `git rev-parse -q --verify "stash@{n}^3"` 判断）。
- stash 提交 parents 结构：`父1=base 提交`、`父2=index 提交`、`父3=untracked 树提交`。stash 工作树完整快照 = stash 提交本身的树。
- **`git stash clear` 只删引用，松散对象仍在库中**。找回方法：`git fsck --unreachable --no-reflogs` 列出不可达提交，按「父提交哈希 + 时间戳 + subject」三重匹配定位 stash 提交；对象自创建起超两周，随时可能被 gc 回收——**找回动作要趁早，且期间不要跑任何触发 gc 的命令**。

### Windows 环境三连坑

1. **CRLF 假冲突**：工作区文件经 autocrlf 检出为 CRLF，`git show` 输出原始 LF；直接 `git merge-file` 会把整个文件判成一个巨大冲突块（冲突区从第 1 行到文件尾即是此症状）。**先 `tr -d '\r'` 归一化当前文件再合并**，冲突数从「全文件」降为真实冲突。
2. **hash-object 哈希误报**：`git hash-object <落盘文件>` 默认套 autocrlf 过滤器，`git hash-object --stdin` 不套 → 同内容两哈希不同。校验一律用 `git hash-object --no-filters`。曾因此误报 2 个文件 MISMATCH，`diff` 确认逐字节一致后定位。
3. **rg 盲区**：rg 默认跳过隐藏文件（搜不到 `.gitignore` 里的冲突标记）且尊重 gitignore 规则；校验冲突标记用 `grep -rn "^<<<<<<< \|^>>>>>>>"`。另外 `.gitignore` 文件里满是 `# ====` 横幅，`^=======$` 才是冲突分隔符，grep 模式要锚死。

### BOM 混入

stash 原始 diff 自带 UTF-8 BOM 行（`\xEF\xBB\xBF`），经合并会混入归档文件头。收尾统一扫描 `head -c 3 | od -An -tx1`，命中即 `sed -i '1s/^\xEF\xBB\xBF//'`。两仓库各清出 2-4 个文件。

## 4. 可迁移的标准工作流（已验证两轮）

```bash
# ① 侦察：每个 stash 的元信息、tracked diffstat、untracked 清单
git stash list
git show -s --format="subject: %s%ndate: %ci%nparents: %P" "stash@{$i}"
git stash show --stat "stash@{$i}"
git -c core.quotepath=false ls-tree -r --name-only "stash@{$i}^3"   # 有 ^3 时

# ② 提取完整文件（C=stash 提交哈希；tracked 用 C，untracked 用 C^3；保持仓库相对路径）
git -c core.quotepath=false diff --name-only "$C^1" "$C"   # 权威的触及文件清单（diffstat 会截断中文/长路径）
git show "$C:$f" > ".debug/$dir/$f"

# ③ 完整性校验（必须全绿才允许 clear stash）
git ls-tree "$C" -- "$f" | awk '{print $3}'                 # 期望 blob 哈希
git hash-object --no-filters ".debug/$dir/$f"               # 实际哈希

# ④ 三方合并升级到当前代码（当前文件先归一化 LF）
git show "$C^1:$f" > base; git show "$C:$f" > stash
tr -d '\r' < "$f" > ".debug/$dir/$f"
git merge-file -L 当前最新 -L 基线 -L stash调试版 ".debug/$dir/$f" base stash
# 退出码 = 冲突数；0=干净；当前无此文件=保留快照；stash 新建且当前已有后代=直接取当前版

# ⑤ 人工解决冲突（原则见 §6）→ ⑥ 全局校验 → ⑦ 配套规则 → ⑧ git stash clear
```

合并后全局校验：`grep -rn "^<<<<<<< \|^>>>>>>>" .debug` 为空、BOM 扫描清零、调试钩子 `grep -c` 抽查（每个 stash 的标志性符号在位，如 `MOCK_HOMING_TOKEN`、`GlobalSkeleton name=`、`hasOrgTreeMock`）。

## 5. 各仓库执行结果

### homing-miniapp-workbench（5 stash → 49 文件）

| 目录 | 要点 |
|---|---|
| 001临时保存本地开发常用目录 | 参考价值低，多数内容已活在当前工作区未提交改动，可最先删 |
| 002直连COS闪记调试代码 | **用户后续要做「新增闪记创建面诊」的直接素材**：`directCosFlash.ts`（改顶部 `DIRECT_COS_FLASH_AUDIO_URL`/`DIRECT_COS_FLASH_COS_PATH` 常量塞自己上传的音频）+ `record.ts`/`index7.tsx`/`indexNew.tsx` 当前版+调试接线（合并零冲突）；mock 开关依赖 `src/services/mock.ts`（在 003 目录） |
| 003进入设备中心与本地Mock设备中心 | 9 接线文件 + 25 个 mock 契约样例（含中文目录原路径保留） |
| 004H5请求全局状态与SDK支撑 | 与 003 三个文件重叠，004 备份更早，重叠以 003 为较新参考 |
| 005智能剪辑背景图未完成 | 契约测试文件当前仓库已无，保留快照 |

### beauty-smart-advisor（6 stash → 41 文件）

| 目录 | 要点 |
|---|---|
| 001本地代理与全局Store调试配置 | gloablStore 的「按本机 IP 注入调试 token 直通」已移植进现行 dev 分支 |
| 002临时保存本地开发常用技能 | `localDev.ts`（LOCAL_DEV_TOKEN/useLocalDevToken 来源）、.gitignore 个人忽略块取并集 |
| 003/004预约助手接入骨架屏组件（两次迭代） | `GlobalSkeleton` 三处包装（门店选择器/日程时间轴/状态统计）移植到当前 BaseLayout 布局；以 003 为较全参考 |
| 005暂存预约助手 | **`GlobalSkeleton` 组件本体完整源码（功能已被仓库移除，仅此存有）**+ webpack jsx-runtime 别名 + 接入文档 |
| 006本地mock门店树 | `hasOrgTreeMock` 门控与当前缓存签名共存 |

## 6. 关键冲突解决决策（原则：保留现行实现、并入 stash 增量）

1. **调试 token 直通（advisor）**：001 版（IP 映射表 `getDebuggingToken()`）插进当前 dev 分支的 `existingToken` 检查之后作兜底放行；002/003 版（`useLocalDevToken && DEBUGGING_TOKEN` 早退）叠加在 `doAuth` 开头。当前硬编码 token 弃用改 `MOCK_HOMING_TOKEN`（homing 同理）。
2. **骨架屏包装移植**：丢弃 stash 的过期布局块（旧位置重复组件），把 `<GlobalSkeleton name="xxx" loading={...}>` 包装重新套在当前版对应节点上，并补传 `statusCountsLoading={board.statisticsLoading}`（hook 的 loading 字段已随干净合并暴露，先 `rg` 确认字段存在再接线）。
3. **useReservationResources 双签名并存**：当前 3 参 `setOrgTreeResources(..., currentEmployeeOrgId)` 缓存签名 + stash 的 `setOrgTreeLoading(false)` 复位行同时保留；006 的 `hasOrgTreeMock` 门控并进当前 early-return 条件与 deps 数组（取并集）。
4. **请求拦截**：当前版整文件重建后手工补 3 行（`getLocalRecordMockResponse` import + homingRequest 内 2 行 mock 短路）。
5. **JSX 冲突截断陷阱**：CalendarSidebar 冲突切在表达式中间，共享冲突尾部的缩进/嵌套属于 stash 侧深度，保留当前侧会得到破损嵌套——此类冲突要**整块重构**（冲突区+共享尾一起替换为当前标记 + 包装层的连贯版本），不能只删标记。
6. **Edit 工具批量构造失误**：曾把 `>>>>>>> PLACEHOLDER` 残留写进文件，下一步立即发现修复。批量 Edit 的 new_string 要逐行核对，尤其在 old_string 跨两个冲突块时。

## 7. 失败尝试及原因（摘要）

| 失败 | 原因 | 修正 |
|---|---|---|
| 首轮合并出现 17 个「第 1 行到文件尾」冲突 | CRLF/LF 未归一化 | `tr -d '\r'` 后重跑，真实冲突大幅减少 |
| 2 个 patch 校验报 MISMATCH 但 diff 逐字节一致 | `git hash-object` 对落盘文件套 autocrlf | 改用 `--no-filters` 复核 |
| rg 搜不到 .gitignore 内冲突标记 | rg 跳过隐藏文件 | 改 grep -rn |
| homing 首轮归档放的是 stash.patch | 用户纠偏：要完整文件不是 diff patch | 从对象库找回 stash 提交重新提取 |

## 8. 遗留问题与后续建议

1. **homing 仓库对象库仍有更早清掉的旧 stash 残留**（7 月的「备份本地代理配置」「主波形渲染未完成」等十余个 WIP），fsck 可见，git 默认策略两周后被 gc 回收——需要一并捞要趁早，不需要就等自动回收。
2. `.debug` 是 stash 清空后的**唯一副本且 git 管不到**：homing 的 002 是后续闪记创建面诊功能的直接素材，勿误删；两仓库 README 都注明了跨目录依赖（homing：002 依赖 003 的 `mock.ts`；advisor：003 依赖 002 的 `localDev.ts` 和 005 的 `GlobalSkeleton`）。
3. 合并结果基于归档当日代码；仓库继续演进后恢复时**先 diff 对照再决定整文件覆盖或摘取段落**（README 已写明）。
4. homing 的 001 目录参考价值最低，清理 `.debug` 时可最先删。
5. 待验证假设：骨架屏归档若将来真要复活，`GlobalSkeleton` 组件（005）+ 三处包装（003）+ 依赖包（005 的 package.json 依赖变更）需整体取回，未做过运行时验证——归档只保证源码级完整。

## 9. 新会话快速恢复上下文

**项目现状**：`homing-miniapp-workbench`（分支 feature/env-v1.7.2）与 `beauty-smart-advisor`（分支 feature/v1.7.1）的陈旧 git stash 已分别于 2026-09-17 归档进各自仓库根的 `.debug/`（49/41 文件，含 README 索引）并 `git stash clear`；两仓库 `.gitignore` 均已忽略 `.debug/`，AGENTS.md 均有「.debug 绝不入库」红线。`.debug` 内文件是「当前代码+stash 增量」的合并结果（LF、无 BOM），git 不再管这些文件。

**关键决策**：完整文件快照而非 patch；冲突原则「保留现行实现、并入 stash 增量」；当前仓库已删的文件保留原始快照；package-lock 不做机械合并；删除 stash 前必须过 blob 哈希校验。

**下一步工作**：用户计划在 homing 做「新增闪记创建面诊」时使用 `.debug/002直连COS闪记调试代码/`：复制 `directCosFlash.ts` 回 `src/subPackage/aiRecorderH5/`，改其顶部 `DIRECT_COS_FLASH_AUDIO_URL`/`DIRECT_COS_FLASH_COS_PATH` 常量为自传音频，照 `record.ts`/`index7.tsx`/`indexNew.tsx` 的接线（`shouldCreateDirectCosFlash` 分支 + `createFlash({recordId, cosPath})` + `updateFlash`）手工接入最新代码。若用户要求清理 `.debug`，先删 homing 001；若要捞 homing 对象库残留的更老 stash，用 `git fsck --unreachable --no-reflogs` 并尽快（gc 前提是对象还在）。
