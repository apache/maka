# Git 常用命令

> 沉淀自实际使用场景,按「场景 → 命令」组织。示例仓库:`microweb-saas-business`。

## 场景:把上游/协作分支最新代码同步进个人分支

个人分支从上游分支拉出、且还没有自有提交时,直接快进(不产生 merge commit):

```bash
git fetch origin feature/4.44.3-xiangyang-czk
git switch feature/active-org-7modules
git merge --ff-only origin/feature/4.44.3-xiangyang-czk
```

- 个人分支已有自有提交时 `--ff-only` 会失败,去掉它改用普通 `git merge`(产生合并提交)。
- 合并前工作区必须干净;未提交内容先 `git stash push -u` 保存(见下)。

## 场景:临时保存未完成工作(含未跟踪的新文件)

```bash
git stash push -u -m "说明文字"   # -u 必须加,否则新增文件不会被收进 stash
git stash list                    # 查看所有 stash
git stash pop                     # 恢复最近一次并删除该条
git stash apply                   # 恢复但不删除,先验证再 drop 更稳
```

## 场景:只从 stash 里恢复部分文件

stash 提交结构:`stash@{0}` 是 tracked 改动树;`stash@{0}^3` 是 untracked 文件树(只有用 `-u` 收纳的 stash 才有第三个父提交)。

```bash
# 恢复 stash 里未跟踪的新文件(进工作区+暂存区)
git checkout stash@{0}^3 -- src/pages/activeManage/xxx
# 恢复 stash 里对已有文件的修改(如公共组件修复)
git checkout stash@{0} -- src/components/ReactEcharts/index.js
```

- 挑着恢复后,确认不再需要该 stash 再 `git stash drop stash@{0}`。
- stash 里的整合文件(菜单 `menuList.js`、路由注册 `active.js` 等)不要整文件恢复:里面可能混着多个模块的条目,拿到别的分支会引用不存在的页面导致编译报错,应手工按需补条目。

## 场景:多分支并行时的防串门

- 动手前先确认分支:`git branch --show-current`
- 切换分支前工作区必须干净;`git status --short` 第一列是暂存区状态,第二列是工作区状态。
- `??` 开头的是未跟踪文件,不在 git 管理下——`git stash push` 不带 `-u` 不会收走它们,保存后务必再看一眼 `git status --short` 确认没有 `??` 残留。

## 案例:2026-10 活动管理 7 模块并行开发与单模块提交流

背景:个人分支 `feature/active-org-7modules` 上开发 7 个静态页面(全部未提交),上游 `feature/4.44.3-xiangyang-czk` 有同事新提交,且当期只需提交其中一个模块(统计汇总)。

1. `git stash push -u -m "..."` 全量保存(含未跟踪的 7 个模块目录)
2. `git switch feature/4.44.3-xiangyang-czk` 切到上游分支(fetch 后落后时先 `git merge --ff-only origin/...`)
3. 单模块入暂存区:`git checkout stash@{0}^3 -- <该模块及公共依赖路径>` + 手工在 menuList/active.js 补该模块的菜单与路由条目,`git add` 后提交推送
4. 个人分支拉回:`git fetch` + `git merge --ff-only origin/feature/4.44.3-xiangyang-czk`
5. 其余 6 个模块留在 stash,后续交付时用 `git checkout stash@{0}^3 -- <目录>` 逐个恢复,全部交付完再 `git stash drop`

### 续:从 stash 手动恢复剩余 6 个模块

不要直接 `git stash pop`:stash 里的菜单改动(7 模块条目)会和已提交的统计汇总条目撞在同一位置直接冲突;用 `checkout` 挑文件绕开。

```bash
# 0. 确认在个人分支,且已同步到统计汇总提交
git branch --show-current && git log --oneline -1

# 1. 恢复 6 个模块的页面代码 + 模块间共用组件(进工作区+暂存区)
git checkout stash@{0}^3 -- src/pages/activeManage/activityAudit src/pages/activeManage/activityReview src/pages/activeManage/activitySignIn src/pages/activeManage/activitySignUp src/pages/activeManage/participationStats src/pages/activeManage/satisfactionBoard src/pages/activeManage/components/replyModal

# 2. 恢复菜单与路由:此 stash 的 menuList/active.js 恰是「全部模块」的完整版,
#    与第 1 步恢复后的页面集合一一对应,可整文件覆盖(上方第 39 行的提醒在此场景下是例外)
git checkout stash@{0} -- src/pages/Main/menu/menuList.js src/router/active.js

# 3. 确认暂存区:6 个模块目录 + replyModal 新增(A),menuList/active.js 修改(M)
git status --short

# 4. 启动验证,页面与菜单齐全后再提交;全部提交完再 git stash drop stash@{0}
```

- 已随首个模块提交过的公共依赖(statSummary、common、statCard、ReactEcharts 修复)不要重复恢复。
- 恢复后菜单/路由缺失,先 `grep <路由关键字> menuList.js active.js` 确认第 2 步是否真的执行到位,再怀疑热更新。

## 场景:目录重构/迁移后的整批提交

目录大量移动后,工作区呈现为「旧路径全 D + 新路径全 ??」。不逐文件 add,按路径圈定一次收编(`git add -A` 的 pathspec 里旧路径也要写,已删除的文件靠它才进得了暂存区),靠改名检测自动配对保历史。以 2026-10-28 cc 仓五区上移 + web 两域重构为例:

```bash
git add -A -- .gitignore README.md guahub/.gitignore guahub/README.md guahub/web web interview passkeys reverse sessions

# 提交前核对暂存范围,不相关目录(如 repositories/)不混进本笔提交
git diff --cached --name-status | awk '{print $1}' | sort | uniq -c   # 预期绝大多数是 R(改名配对)
git diff --cached --name-status | grep -v '^R' | head -20             # 抽查非改名项是否都该进

git commit -m "chore(guahub): 目录重构——web 拆美业(meiye)/康养(senior)两域,与 interview/sessions/reverse/passkeys 一同上移仓根,白名单同步切换"
git push origin main
```

- 想搭车提交的散文件(如本文件)单独补路径加进 add,别图省事 `git add -A` 全仓收。
- 追溯移动过的文件用 `git log --follow <新路径>`,改名配对后历史不断。

## 场景:仓库历史单根重建(无父提交)与本地缓存清理

把整个仓库历史压成一条无父根提交,再清掉本地一切旧历史痕迹。适用于远程已被另一端 force-push 单根重建后本地对齐,或主动重建个人仓。**不可逆**:第 5 步执行后旧提交对象被物理清除,唯一退路是第 0 步的仓外 bundle。

前置:工作区干净(未提交改动先按上节收编;`??` 未跟踪项不会进根提交,重建后保持原状);多机仓库确认其他机器没有未推送的本地提交,并打好招呼。

```bash
cd <仓库根>

# 0. (可选,推荐)仓外一次性备份,验证新历史无误后删除
git bundle create ../<仓名>-before-rebuild.bundle --all

# 1. 孤儿分支建无父提交(--orphan 保留索引与工作区,已跟踪内容原样收成一笔)
git checkout --orphan new-root
git commit -m "<仓名> 个人工作区单根重建——孤儿提交全量收编"

# 2. 换回 main
git branch -D main
git branch -m main

# 3. 有远程的强推重建
git push -f origin main

# 4. 验证:只剩 1 个提交、根提交无父
git log --oneline
git rev-list --max-parents=0 HEAD

# 5. 清理本地旧痕迹(不可逆,第 4 步验证无误后再执行)
git branch -D backup/main-20261026        # 备份分支,以 git branch -a 实际名单为准
git stash clear
git reflog expire --expire=now --all
git gc --prune=now --aggressive           # 连带清掉 .git/objects 里的 tmp_obj_/tmp_pack_ 中断垃圾
git count-objects -vH                     # 记录 size-pack 清理前后对比
```

- 两仓现状(2026-10-28 实测):`E:\cc`(origin=ggbdpq/cc) size-pack 2.32GiB,有 `backup/main-20261026` 备份分支与 `C:\Users\802165\AppData\Local\Temp\cc-pull-backup*` 两份残留;`C:\Users\802165`(origin=ggbdpq/home) size-pack 242MiB,无备份分支。%TEMP% 备份目录确认无用后直接删。
- force-push 后其余机器执行 `git fetch && git reset --hard origin/main` 对齐,不要 merge(unrelated histories 会拒绝)。
- 推送通道:本机 22 端口 git 通道不稳,ssh 推不动时 `git remote set-url origin https://github.com/ggbdpq/<仓名>.git` 切 https(gh 凭证助手)。
- 重建动作一口气做完,别让仓库停在孤儿分支上过夜(本机有自动提交任务在动 main)。
