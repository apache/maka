# git worktree 生命周期与测试排障实操（coding-agent v0.6 升级）
**一句话总结**：多分支并行开发用 git worktree 全流程（建→核→删），外加 macOS Python 版本陷阱、管道吃退出码、错误提交回退这几个反复验证过的坑。

## 背景
在 coding-agent 仓库做 v0.6 升级：三个子智能体各占一个 worktree 并行开发，最后串行合入 main；期间跑全量测试、做红操演练、修对抗审查发现的问题，踩了一串本机环境与 git 操作的坑。

## 核心命令
```bash
# worktree 三件套：从标签/提交建分支独立目录 → 并行开发 → 合并后删除
git worktree add ../ca-A -b feat/feature-a v06-base
git worktree remove ../ca-A          # 删除前先核实，见下

# 删 worktree 前核实两件事：分支有无未合入提交、工作区是否干净
git log --oneline main..feat/feature-a | wc -l   # 0 = 全部已合入
git -C ../ca-A status --short                     # 空 = 无未提交改动

# macOS 本机补 python 链接（脚本/子进程里 python 落到系统 3.9 时的修法）
ln -s ~/.local/bin/python3.13 ~/.local/bin/python

# Python 测试一律显式版本调用（非交互 shell 的 python3 是 3.9，见结论 1）
python3.13 -m unittest discover -s test
python3.13 - <<'EOF'          # heredoc 批量精确替换文件，先断言再替换防错位
p = '目标文件'
s = open(p).read()
old = "旧代码"
new = "新代码"
assert old in s               # 锚点不唯一/不存在时直接失败，不静默改错
open(p, 'w').write(s.replace(old, new, 1))
EOF

# 零依赖 TS 项目不装依赖直跑单测（Node 24 原生类型剥离）
node --test test/xxx.test.ts

# 提交错拆/错混时的回退：软回退保留改动，按文件重新暂存
git reset --soft HEAD~1                  # 撤销提交但保留全部改动在暂存区
git restore --staged 混入的文件.ts       # 把不该进这个提交的文件移出暂存区
git commit -m "重建的干净提交"

# 取真实退出码：别经过管道（管道后 $? 是 tail/grep 的）
node check.mjs 参数 >/dev/null 2>&1; echo "exit=$?"

# ⚠️ 还原红操注入：丢弃指定文件的未提交修改，确认文件里没有要保留的东西再跑
git checkout -- src/被注入的文件.ts
```

## 关键结论
1. **macOS 非交互 shell 的 `python3` 是 CommandLineTools 的 3.9**：代码里 `str | None` 这类语法直接 ImportError，且报错看起来像代码坏了。根因是交互 shell 靠 alias 指 3.13，脚本和子进程拿不到 alias。一切脚本化调用显式写 `python3.13`；工具硬编码 `python` 的场景补一个 `~/.local/bin` 符号链接。
2. **管道会吃掉退出码**：`cmd | tail` 之后 `$?` 是 tail 的 0，失败被记成通过。本次两次踩中（测试门禁假绿、攻击验证假红）。要退出码就让命令直接结束再 echo `$?`，输出落文件再 grep。
3. **`git add -u <目录>` 会顺手暂存目录下所有修改**：一次删除提交里混进了 5 个无关 .ts 的半成品改动。按文件精确 add；已经提错就 `reset --soft HEAD~1` + 逐文件重新暂存重建，历史干净且不丢改动。
4. **浏览器测试大批量失败先怀疑时序而非功能**：87 个用例串行各起一次 Chrome，失败集合随轮次漂移、任意失败用例单跑即绿、耗时全部贴着超时天花板（~4s）——这三条凑齐就是等待超时抖动，处置是放宽默认超时上限（4s→15s），不弱化任何断言。
5. **后台子智能体会被 5 小时用量上限杀掉**：回收现场时先 `git status` 查它留下来的工作树状态（本次死前只留了待提交编辑、没有未还原的注入），别假设它按计划收尾。
6. **测试冻结前做红操**：往被测代码注入最小漂移（如"去掉守卫""忽略配置"），确认对应用例真的转红再还原。本次靠这个抓出一个死断言——期望哈希字典根本没参与 assert，测试恒绿。

## 下次怎么用
- 多任务并行改同一个仓库：worktree 建独立目录，收尾按"未合入提交数=0 + 工作区干净"两条核实后删除。
- 跑测试/脚本前先确认 python 版本来源（`which -a python3`）；写批量文件改动用 heredoc + assert 锚点的模式。
- 测试大批量红：先对比两轮失败集合是否漂移、抽一个单跑，再决定是修环境还是修代码。
- 提交拆错了：`reset --soft` 回退重建，不要 `reset --hard`。
