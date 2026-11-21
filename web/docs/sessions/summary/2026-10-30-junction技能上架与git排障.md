# Junction 技能上架与 git 路径排障

**一句话总结**：把插件仓库里的深层技能用 junction 提升上架到全局技能视图，并排查清楚"分类文件丢失"其实是分类改名后的旧空壳，顺带沉淀 Windows junction 与中文路径的 git 排障命令。

## 背景

两件事：① 要把一个插件仓库（技能埋在第六层）的 4 个技能加入全局技能视图，但收集脚本只扫三层；② 同事反馈某分类下 SKILL.md 全不见了，怀疑 git 提交搞漏，需要排查能否找回。

## 核心命令

```bash
# 建 Windows 目录 junction（Git Bash 里 mklink 不可用，用 node 的 fs API）
node -e "const fs=require('fs'); fs.symlinkSync('C:/源/真身目录', 'C:/目标/链接名', 'junction')"

# 技能上架标准流程：先演练（应只多预期条数的建链），确认后实跑，再全端分发
node sk-rebuild.js --dry-run
node sk-rebuild.js
node sk-sync.js --dry-run   # 看阶段1 将删应为 0、阶段3 各端 联接 n/n [OK]
node sk-sync.js

# 用未转义的中文路径核对 git 实际跟踪了哪些文件（ quotepath 默认转义中文）
git -c core.quotepath=false ls-files | grep "某分类/"

# 查某路径的历史提交（判断文件是哪次变更动的）
git log --oneline -15 -- "路径/子目录/"
git show --stat <commit>    # 看该提交动了哪些文件

# 查本地与远程的领先/落后
git fetch origin && git rev-list --left-right --count main...origin/main
```

## 关键结论

1. **Node 的 `readdir` 把 junction 报成 symlink**（`isDirectory()` 为 false），任何"只收目录"的遍历逻辑要放行 `isSymbolicLink()`；而 `lstat`/`existsSync` 穿透 junction 解析路径，检测内部文件不受影响。递归遍历遇到 junction 当叶子处理（不深入），防环。
2. **深层技能上架不搬文件**：在收集器扫描的层级为每个技能建 junction 指向插件内部目录，插件仓库保持完整，再走 manifest + 重建/分发脚本。
3. **"文件全没了"先怀疑目录改名/迁移，别急着找回**：git status 干净 + 工作区没文件 + 直觉上"应该有"，大概率是分类改名后旧位置只剩空壳（本次只剩 `__pycache__/*.pyc`，git 不跟踪所以 status 不报）。真身在新分类完好。
4. **grep 中文路径的坑**：`git ls-files` 默认把非 ASCII 转义成八进制串，直接 grep 中文或编号片段会产生假匹配/假阴性；加 `-c core.quotepath=false` 拿真实路径再核对。
5. 只读对账脚本（status/diff 全绿但文件缺失）矛盾时，用 `git -c core.quotepath=false ls-tree HEAD:目录` 直接看 HEAD 树里的真实目录名，一步定位改名。

## 下次怎么用

- 多客户端技能库上架新技能：建 junction（如需）→ 改 manifest → 脚本 `--dry-run` 确认只多预期建链 → 实跑 → 分发 → 只读校验脚本收口。
- 任何"文件丢了"的排查顺序：`ls-files`（quotepath=false）看跟踪 → `ls-tree HEAD` 看真名 → `log -- <路径>` 看哪次动的 → 最后才考虑 checkout 恢复；九成是改名/移动而非丢失。
- 产物类并行任务可按"每子任务固定输入路径 + 固定产物目录 + 明确跳过规则"的任务书拆给子智能体并行执行，产物集中落盘便于验收。
